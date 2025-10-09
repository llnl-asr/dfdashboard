from typing import Literal, Tuple

import numpy as np
import pandas as pd

from bokeh.models import ColumnDataSource, LinearAxis, Range1d, Legend, LegendItem
from bokeh.plotting import figure
from bokeh.models import LayoutDOM
from bokeh.document import without_document_lock

from dfdashboard.base.component import DFDashboardComponent
from dfdashboard.base.runtime import DFDashboardRuntime
from dfdashboard.data_utils import assign_seconds, create_timeline
from dfdashboard.components.async_utils import AsyncContainer

TIME_COLS = ["io_time", "app_io_time"]


class BandwidthTimeline(DFDashboardComponent):
    def __init__(
        self,
        time_col: Literal["io_time", "app_io_time"],
        figsize: Tuple[int, int],
        bw_unit: Literal["kb", "mb", "gb", "tb"] = "kb",
        line1_label: str = "I/O Time",
        line2_label: str = "I/O Bandwidth",
        xlabel: str = "Timeline (sec)",
        y1label: str = "Time (sec)",
        y2label: str = "Bandwidth",
        x_num_ticks: int = 10,
        y_num_ticks: int = 5,
    ):
        super().__init__()
        self.time_col = time_col
        self.figsize = figsize
        self.bw_unit = bw_unit
        self.line1_label = line1_label
        self.line2_label = line2_label
        self.xlabel = xlabel
        self.y1label = y1label
        self.y2label = y2label
        self.x_num_ticks = x_num_ticks
        self.y_num_ticks = y_num_ticks

        self.size_denom = 1024
        self.size_suffix = "KB/s"
        if self.bw_unit == "mb":
            self.size_denom = 1024**2
            self.size_suffix = "MB/s"
        elif self.bw_unit == "gb":
            self.size_denom = 1024**3
            self.size_suffix = "GB/s"
        elif self.bw_unit == "tb":
            self.size_denom = 1024**4
            self.size_suffix = "TB/s"

        self.source1 = ColumnDataSource(data=dict(x=[], y=[]))
        self.source2 = ColumnDataSource(data=dict(x=[], y=[]))

    def _process_timeline_data(self, runtime: DFDashboardRuntime, size_denom: int):
        """Process timeline data synchronously - will be run in executor."""
        timeline = create_timeline(runtime.analyzer)
        if timeline is None:
            raise ValueError("create_timeline returned None")

        timeline = timeline.reset_index()

        def _set_bw(df: pd.DataFrame):
            df = df.copy()
            for col in TIME_COLS:
                # Keep time in microseconds for bandwidth calculation to avoid huge values
                df[f"{col}_bw"] = (df["size"] / size_denom) / (df[col] / 1e6)
            df.replace([np.inf, -np.inf], np.nan, inplace=True)
            for col in TIME_COLS:
                df[f"{col}_bw"] = df[f"{col}_bw"].fillna(0)
            return df

        timeline = (
            timeline.map_partitions(_set_bw)
            .compute()
            .assign(seconds=assign_seconds)
            .sort_values("seconds")
        )
        return timeline

    def build(self, runtime: DFDashboardRuntime) -> LayoutDOM:

        root = figure(
            title="Bandwidth Timeline",
            width=self.figsize[0],
            height=self.figsize[1],
            x_axis_label=self.xlabel,
            y_axis_label=self.y1label,
            tools="pan,wheel_zoom,box_zoom,reset,save",
        )

        container = AsyncContainer(
            loading_overlay=False,
            loading_content="Loading bandwidth timeline data...",
            error_content=lambda err: f"❌ Failed to load timeline: {err}",
            delay=0.2,
        )

        wrapped_root = container.wrap(root)

        def update_plot_with_data(timeline):
            """Update the plot with loaded timeline data."""
            if self.time_col == "io_time":
                phase = 2
            else:
                phase = 3

            filtered_timeline = timeline.query(f"phase == {phase}")

            if len(filtered_timeline) == 0:
                root.text(
                    [0.5],
                    [0.5],
                    text=["No data available for selected phase"],
                    text_align="center",
                    text_baseline="middle",
                )
                return

            x_data = filtered_timeline["seconds"].values
            y1_data = filtered_timeline[self.time_col].values / 1e6
            y2_data = filtered_timeline[f"{self.time_col}_bw"].values

            self.source1.data = dict(x=x_data, y=y1_data)
            self.source2.data = dict(x=x_data, y=y2_data)

            line1 = root.line(
                "x",
                "y",
                source=self.source1,
                line_color="blue",
                line_alpha=0.8,
                line_width=2,
            )

            y2_max = np.max(y2_data) if len(y2_data) > 0 else 1
            has_y2 = y2_max > 0

            line2 = None
            if has_y2:
                root.extra_y_ranges = {"bandwidth": Range1d(start=0, end=y2_max)}
                secondary_axis = LinearAxis(
                    y_range_name="bandwidth",
                    axis_label=f"{self.y2label} ({self.size_suffix})",
                )
                root.add_layout(secondary_axis, "right")

                line2 = root.line(
                    "x",
                    "y",
                    source=self.source2,
                    line_color="orange",
                    line_alpha=0.8,
                    line_width=2,
                    line_dash="dashed",
                    y_range_name="bandwidth",
                )

            legend_items = [LegendItem(label=self.line1_label, renderers=[line1])]
            if line2:
                legend_items.append(
                    LegendItem(label=self.line2_label, renderers=[line2])
                )

            legend = Legend(items=legend_items, location="top_left")
            legend.click_policy = "hide"

            root.add_layout(legend, "right")

        @without_document_lock
        async def load_timeline_data():
            """Load timeline data using AsyncContainer."""
            await container.load_async(
                operation=self._process_timeline_data,
                runtime=runtime,
                on_success=update_plot_with_data,
                loading_message="Loading bandwidth timeline...",
                size_denom=self.size_denom,
            )

        runtime.io_loop.spawn_callback(load_timeline_data)

        return wrapped_root


class TransferSizeTimeline(DFDashboardComponent):
    def __init__(
        self,
        figsize: Tuple[int, int],
        unit: Literal['kb', 'mb', 'gb'] = 'kb',
        xlabel: str = 'Timeline (sec)',
        ylabel: str = 'Transfer Size',
        x_num_ticks: int = 10,
        y_num_ticks: int = 5,
    ):
        super().__init__()
        self.figsize = figsize
        self.unit = unit
        self.xlabel = xlabel
        self.ylabel = ylabel
        self.x_num_ticks = x_num_ticks
        self.y_num_ticks = y_num_ticks

        self.source = ColumnDataSource(data=dict(x=[], y=[]))

    def _process_transfer_data(self, runtime: DFDashboardRuntime, size_denom: int):
        """Process transfer size data synchronously - will be run in executor."""
        timeline = create_timeline(runtime.analyzer)
        if timeline is None:
            raise ValueError("create_timeline returned None")
            
        timeline = timeline.reset_index()
        
        def _set_xfer_size(df: pd.DataFrame):
            # Create a copy to avoid modifying the original data structure
            result_df = df.copy()
            result_df['xfer'] = result_df['size'] / size_denom / result_df['index']
            return result_df

        timeline = (
            timeline.query("phase == 2")
            .map_partitions(_set_xfer_size)
            .compute()
            .assign(seconds=assign_seconds)
            .sort_values("seconds")
        )
        return timeline

    def build(self, runtime: DFDashboardRuntime) -> LayoutDOM:
        size_denom = 1024
        ylabel_unit = 'KB'
        if self.unit == 'mb':
            size_denom = 1024 ** 2
            ylabel_unit = 'MB'
        elif self.unit == 'gb':
            size_denom = 1024 ** 3
            ylabel_unit = 'GB'

        root = figure(
            title="Transfer Size Timeline",
            width=self.figsize[0],
            height=self.figsize[1],
            x_axis_label=self.xlabel,
            y_axis_label=f"{self.ylabel} ({ylabel_unit})",
            tools="pan,wheel_zoom,box_zoom,reset,save",
        )

        container = AsyncContainer(
            loading_overlay=False,
            loading_content="Loading transfer size data...",
            error_content=lambda err: f"❌ Failed to load transfer size: {err}",
            delay=0.1
        )

        wrapped_root = container.wrap(root)

        def update_plot_with_data(timeline):
            """Update the plot with loaded timeline data."""
            if len(timeline) == 0:
                root.text(
                    [0.5], [0.5],
                    text=["No transfer data available"],
                    text_align="center",
                    text_baseline="middle",
                )
                return

            x_data = timeline["seconds"].values
            y_data = timeline["xfer"].values

            self.source.data = dict(x=x_data, y=y_data)

            root.line(
                "x", "y",
                source=self.source,
                line_color="red",
                line_alpha=0.8,
                line_width=2,
                legend_label="Avg. Transfer Size"
            )

            root.legend.click_policy = "hide"

        @without_document_lock
        async def load_transfer_data():
            """Load transfer size data using AsyncContainer."""
            await container.load_async(
                operation=self._process_transfer_data,
                runtime=runtime,
                on_success=update_plot_with_data,
                loading_message="Loading transfer size data...",
                size_denom=size_denom
            )

        runtime.io_loop.spawn_callback(load_transfer_data)

        return wrapped_root
