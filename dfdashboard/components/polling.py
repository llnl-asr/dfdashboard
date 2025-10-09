import random
from typing import Any
from bokeh.layouts import column
from bokeh.models import ColumnDataSource
from bokeh.plotting import figure
from bokeh.models import LayoutDOM

from dfdashboard.base.component import DFDashboardPollableComponent
from dfdashboard.base.runtime import DFDashboardRuntime


class DummyPollingPlot(DFDashboardPollableComponent):
    def __init__(self):
        super().__init__()
        self.source = ColumnDataSource(data={"x": [], "y": []})
        self.counter = 0

    def build(self, runtime: DFDashboardRuntime) -> LayoutDOM:
        fig = figure(title="Polling Demo", width=400, height=300)
        fig.line("x", "y", source=self.source)
        self.root = column(fig)
        return self.root

    def update(self, runtime: DFDashboardRuntime):
        def update_source():
            self.counter += 1
            new_x = self.counter
            new_y = random.randint(0, 10)
            self.source.stream({"x": [new_x], "y": [new_y]}, rollover=100)

        runtime.document.add_next_tick_callback(update_source)

    def polling_interval_ms(self) -> int:
        return 2000  # update every 2 seconds
