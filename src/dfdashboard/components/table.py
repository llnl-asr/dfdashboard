from typing import Dict, List, Optional
from dataclasses import dataclass

from bokeh.models import ColumnDataSource, DataTable, TableColumn, Button, Div, TextInput
from bokeh.layouts import column, row
from bokeh.models import LayoutDOM
from bokeh.document import without_document_lock

from dfdashboard.base.component import DFDashboardComponent
from dfdashboard.base.runtime import DFDashboardRuntime
from dfdashboard.components.async_utils import AsyncContainer
from dfdashboard.data_utils import length

class EventsTable(DFDashboardComponent):
    _columns_defs: Dict[str, str] = {
        "row_num": "#",
        "name": "Name",
        "ts": "Start",
        "te": "End",
        "dur": "Duration",
        "size": "Size",
        "step": "Step",
        "epoch": "Epoch"
    }

    def __init__(self, page_size: int = 50, exclude_columns: Optional[List[str]] = None):
        super().__init__()
        self.page_size = page_size
        self.current_page = 0
        self.filtered_data = None
        self.total_items = 0
        
        self._columns = {}
        if exclude_columns and len(exclude_columns) > 0:
            self._columns = {k: v for k, v in self._columns_defs.items() if k not in exclude_columns}
        else:
            self._columns = self._columns_defs

        self.source = ColumnDataSource(data={col: [] for col in self._columns.keys()})
        self.query: Optional[str] = None
    
    def load_events_data(self, runtime: DFDashboardRuntime, query: str = ""):
        data_columns = [col for col in self._columns.keys() if col != 'row_num']
        
        if self.query:
            if query.strip() == self.query:
                filtered_data = self.filtered_data
            else:
                if query.strip():
                    filtered_data = runtime.analyzer.events[data_columns].query(query)
                else:
                    filtered_data = runtime.analyzer.events[data_columns]
        else:
            if query.strip():
                filtered_data = runtime.analyzer.events[data_columns].query(query)
            else:
                filtered_data = runtime.analyzer.events[data_columns]
            
        
        if self.filtered_data is not filtered_data:
            self.total_items = length(filtered_data)
            self.filtered_data = filtered_data
        
        start_idx = self.current_page * self.page_size
        end_idx = start_idx + self.page_size
        page_data = filtered_data.compute().iloc[start_idx:end_idx].copy()
        
        page_data['row_num'] = range(start_idx + 1, start_idx + len(page_data) + 1)

        return page_data
    
    def build(self, runtime: DFDashboardRuntime) -> LayoutDOM:
        columns: List[TableColumn] = []

        for col, title in self._columns.items():
            if col == "row_num":
                columns.append(TableColumn(field=col, title=title, width=50))
            else:
                columns.append(TableColumn(field=col, title=title))

        table = DataTable(
            source=self.source,
            columns=columns,
            sizing_mode="stretch_both",
            min_width=300,
            min_height=400,
            index_position=None
        )
        
        # Query input and controls
        query_input = TextInput(placeholder="Enter query (e.g., name.str.contains('MPI'))", sizing_mode="stretch_width")
        search_btn = Button(label="Search", width=100)
        clear_btn = Button(label="Clear", width=100)
        
        query_controls = row(query_input, search_btn, clear_btn, sizing_mode="stretch_width")
        
        prev_btn = Button(label="Previous", width=120, disabled=True)
        next_btn = Button(label="Next", width=120)
        status_div = Div(text="", sizing_mode="stretch_width")
        nav_controls = row(prev_btn, status_div, next_btn, sizing_mode="stretch_width")
        
        root = column(query_controls, table, nav_controls, sizing_mode="stretch_both", spacing=10)
        
        ctr = AsyncContainer(
            loading_overlay=True,
            overlay_position="center",
            loading_content="Loading events data...",
            error_content=lambda err: f"❌ Failed to load events: {err}",
            dim_content=True,
            spinner_style="📊",
            delay=0.2
        )
        
        wrapped_root = ctr.wrap(root)
        
        def update_table_data(page_data):
            self.source.data = page_data

            total_pages = max(1, (self.total_items + self.page_size - 1) // self.page_size)
            
            prev_btn.disabled = (self.current_page == 0)
            next_btn.disabled = (self.current_page >= total_pages - 1)
            
            start_item = self.current_page * self.page_size + 1
            end_item = min((self.current_page + 1) * self.page_size, self.total_items)
            status_div.text = f"Showing {start_item}-{end_item} of {self.total_items} items (Page {self.current_page + 1} of {total_pages})"

        @without_document_lock
        async def load_page():
            query = query_input.value or ""
            await ctr.load_async(
                operation=self.load_events_data,
                runtime=runtime,
                on_success=update_table_data,
                loading_message=f"Loading page {self.current_page + 1}...",
                query=query
            )
        
        def prev_page():
            if ctr.is_loading:
                return
            if self.current_page > 0:
                self.current_page -= 1
                runtime.io_loop.spawn_callback(load_page)
        
        def next_page():
            if ctr.is_loading:
                return
            if self.filtered_data is not None and self.total_items > 0:
                total_pages = max(1, (self.total_items + self.page_size - 1) // self.page_size)
                if self.current_page < total_pages - 1:
                    self.current_page += 1
                    runtime.io_loop.spawn_callback(load_page)
        
        def search_data():
            if ctr.is_loading:
                return
            self.current_page = 0  # Reset to first page when searching
            runtime.io_loop.spawn_callback(load_page)
        
        def clear_search():
            if ctr.is_loading:
                return
            query_input.value = ""
            self.current_page = 0  # Reset to first page when clearing
            runtime.io_loop.spawn_callback(load_page)
        
        prev_btn.on_click(prev_page)
        next_btn.on_click(next_page)
        search_btn.on_click(search_data)
        clear_btn.on_click(clear_search)
        query_input.on_change('value', lambda attr, old, new: runtime.io_loop.spawn_callback(search_data) if not ctr.is_loading else None)
        
        runtime.io_loop.spawn_callback(load_page)
        
        return wrapped_root