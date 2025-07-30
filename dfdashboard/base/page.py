from typing import Any, Dict, Optional, Type, cast

from bokeh.core.properties import without_property_validation
from bokeh.models import LayoutDOM, TabPanel, Tabs
from bokeh.layouts import row, column, layout, gridplot
from bokeh.document import Document

from dfdashboard.utils import import_subclass

from dfdashboard.base.component import (
    DFDashboardComponent,
    DFDashboardPollableComponent,
)
from dfdashboard.base.runtime import DFDashboardRuntime

import weakref


# Taken from https://github.com/dask/distributed/blob/main/distributed/dashboard/components/__init__.py
def add_periodic_callback(doc: Document, component: DFDashboardComponent, runtime: DFDashboardRuntime, interval: int):
    """Add periodic callback to doc in a way that avoids reference cycles

    If we instead use ``doc.add_periodic_callback(component.update, 100)`` then
    the component stays in memory as a reference cycle because its method is
    still around.  This way we avoid that and let things clean up a bit more
    nicely.

    TODO: we still have reference cycles.  Docs seem to be referred to by their
    add_periodic_callback methods.
    """

    ref = weakref.ref(component)

    doc.add_periodic_callback(lambda: update(ref, runtime=runtime), interval)
    _attach(doc, component)


# Taken from https://github.com/dask/distributed/blob/main/distributed/dashboard/components/__init__.py
@without_property_validation
def update(ref: weakref.ref, runtime: DFDashboardRuntime):
    comp = ref()
    if comp is not None:
        comp.update(runtime=runtime)

# Taken from https://github.com/dask/distributed/blob/main/distributed/dashboard/components/__init__.py
def _attach(doc: Document, component: DFDashboardComponent):
    if not hasattr(doc, "components"):
        doc.components = set()

    doc.components.add(component.get_root())

layout_map = {
    "row": row,
    "column": column,
    "layout": layout,
    "gridplot": gridplot,
}


class DFDashboardPage:
    """
    DFDashboard Page
    """

    def __init__(
        self,
        document: Document,
        runtime: DFDashboardRuntime,
        layout_config: Dict[str, Any],
    ):
        self.document = document
        self.runtime = runtime
        self.layout_config = layout_config
        self.component_instances: Dict[str, Any] = {}
        self.root: Optional[LayoutDOM] = None

    def build(self):
        """
        Recursively builds the Bokeh layout from the config tree.
        """

        def _build_node(node: Dict[str, Any]):
            node_type = node["type"]
            node_args = node.get("args", {})

            if node_type == "component":
                cid = node.get("id")
                comp_args = node_args.get("args", {})

                cls = import_subclass(node_args["class_path"], DFDashboardComponent)

                comp: DFDashboardComponent = cls(**comp_args)
                self.component_instances[cid] = comp
                return comp.build(runtime=self.runtime)


            if node_type == "tabs":
                tab_sizing_mode = node_args.get("sizing_mode", "stretch_both")
                node_args.pop("sizing_mode", None)
                tabs_config = {
                    "tabs": [
                        TabPanel(
                            title=tab["title"], child=_build_node(tab["content"])
                        )
                        for tab in node.get("children", [])
                    ],
                    "sizing_mode": tab_sizing_mode
                }

                tabs = Tabs(**tabs_config, **node_args)
                return cast(LayoutDOM, tabs)
            
            children: list[LayoutDOM] = [
                _build_node(child) for child in node.get("children", [])
            ]

            layout_cls: Type[LayoutDOM] = layout_map.get(node_type)
            if layout_cls is None:
                raise ValueError(f"Unsupported layout type: {node_type}")
            return layout_cls(*children, **node_args)

        if isinstance(self.layout_config, list):
            self.root = cast(
                LayoutDOM, column(*[_build_node(n) for n in self.layout_config])
            )
        else:
            self.root = _build_node(self.layout_config)

        for comp in self.component_instances.values():
            if isinstance(comp, DFDashboardPollableComponent):
                interval = comp.polling_interval_ms()
                add_periodic_callback(doc=self.document, component=comp, runtime=self.runtime, interval=interval)

        return self.root

    def get_component(self, component_id: str):
        return self.component_instances.get(component_id)
