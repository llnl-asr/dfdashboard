from abc import ABC, abstractmethod
from bokeh.models import LayoutDOM
from typing import Optional

from dfdashboard.base.runtime import DFDashboardRuntime


class DFDashboardComponent(ABC):
    """
    Base class for all DFDashboard components.
    """

    def __init__(self):
        self.root: Optional[LayoutDOM] = None

    @abstractmethod
    def build(self, runtime: DFDashboardRuntime) -> LayoutDOM:
        """
        Construct and return the Bokeh layout/model for this component
        """
        pass

    def get_root(self) -> LayoutDOM:
        """
        Return the Bokeh layout (after build). Raises error if not built yet.
        """
        if self.root is None:
            raise RuntimeError("Component layout not yet built. Call build() first.")
        return self.root

class DFDashboardPollableComponent(DFDashboardComponent):
    """
    Component that support periodic polling
    """

    @abstractmethod
    def update(self, runtime: DFDashboardRuntime) -> None:
        """
        Called by the Page periodically to refresh data or state.
        Must schedule updates safely using `runtime.document.add_next_tick_callback`.
        """
        pass

    def polling_interval_ms(self) -> int:
        """
        Default polling interval in milliseconds.
        """
        return 5000  # every 5 seconds
