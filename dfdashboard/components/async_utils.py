"""
Simple async utilities inspired by React Suspense for Bokeh components.
Provides clean abstractions for handling loading states, errors, and async operations.
"""

from typing import Any, Callable, Optional, Union
import logging
import asyncio
from dataclasses import dataclass
from enum import Enum

import tornado.gen
from bokeh.models import LayoutDOM, Div

from dfdashboard.base.runtime import DFDashboardRuntime

log = logging.getLogger(__name__)


class AsyncContainerState(Enum):
    """Enumeration for AsyncContainer states."""
    MAIN = "main"
    LOADING = "loading"
    ERROR = "error"


@dataclass
class AsyncBoundary:
    """Handles loading states, errors, and data updates for async operations."""
    loading_message: str = "Loading..."
    error_fallback: Optional[Callable[[str], str]] = None
    delay: float = 0.1
    is_loading: bool = False
    error: Optional[str] = None
    data: Any = None
    
    def __post_init__(self):
        if self.error_fallback is None:
            self.error_fallback = lambda err: f"Error: {err}"
    
    async def run(
        self,
        operation: Callable,
        runtime: DFDashboardRuntime,
        on_success: Optional[Callable] = None,
        on_error: Optional[Callable] = None,
        loading_callback: Optional[Callable] = None,
        **operation_kwargs
    ):
        if self.is_loading:
            return None
        
        self.is_loading = True
        self.error = None
        
        if loading_callback:
            runtime.document.add_next_tick_callback(
                lambda: loading_callback(self.loading_message)
            )
        
        try:
            if self.delay > 0:
                await tornado.gen.sleep(self.delay)
            
            if asyncio.iscoroutinefunction(operation):
                result = await operation(runtime, **operation_kwargs)
            else:
                result = await runtime.io_loop.run_in_executor(None, lambda: operation(runtime, **operation_kwargs))
            
            self.data = result
            self.error = None
            
            if on_success:
                def success_wrapper():
                    try:
                        on_success(result)
                    finally:
                        self.is_loading = False
                runtime.document.add_next_tick_callback(success_wrapper)
            else:
                self.is_loading = False
            
            return result
            
        except Exception as e:
            error_msg = str(e)
            self.error = error_msg
            self.data = None
            
            log.error(f"Async operation failed: {error_msg}")
            
            if on_error:
                def error_wrapper():
                    try:
                        on_error(error_msg)
                    finally:
                        self.is_loading = False
                runtime.document.add_next_tick_callback(error_wrapper)
            else:
                self.is_loading = False
            
            return None


class AsyncContainer:
    """Universal async wrapper for components with overlay and content replacement modes."""
    
    def __init__(
        self,
        loading_content: Union[LayoutDOM, str, Callable[[], LayoutDOM]] = None,
        error_content: Union[LayoutDOM, str, Callable[[str], LayoutDOM]] = None,
        delay: float = 0.1,
        loading_overlay: bool = False,
        overlay_position: str = "top-right",
        overlay_style: Optional[dict] = None,
        dim_content: bool = True,
        spinner_style: str = "⏳"
    ):
        self.loading_content = loading_content or "Loading..."
        self.error_content = error_content or (lambda err: f"Error: {err}")
        self.delay = delay
        self.loading_overlay = loading_overlay
        self.overlay_position = overlay_position
        self.dim_content = dim_content
        self.spinner_style = spinner_style
        
        if overlay_style is None:
            if overlay_position == "center":
                self.overlay_style = {
                    "position": "absolute",
                    "top": "50%", "left": "50%",
                    "transform": "translate(-50%, -50%)",
                    "background": "rgba(255, 255, 255, 0.95)",
                    "border": "1px solid #ddd",
                    "border-radius": "8px",
                    "padding": "20px",
                    "box-shadow": "0 4px 12px rgba(0,0,0,0.15)",
                    "z-index": "1000"
                }
            elif overlay_position == "top-right":
                self.overlay_style = {
                    "position": "absolute",
                    "top": "10px", "right": "10px",
                    "background": "rgba(255, 255, 255, 0.95)",
                    "border": "1px solid #ddd",
                    "border-radius": "6px",
                    "padding": "8px 12px",
                    "box-shadow": "0 2px 8px rgba(0,0,0,0.1)",
                    "z-index": "1000"
                }
            else:
                self.overlay_style = {
                    "position": "absolute",
                    "top": "10px", "left": "10px",
                    "background": "rgba(255, 255, 255, 0.95)",
                    "border": "1px solid #ddd",
                    "border-radius": "6px",
                    "padding": "8px 12px",
                    "box-shadow": "0 2px 8px rgba(0,0,0,0.1)",
                    "z-index": "1000"
                }
        else:
            self.overlay_style = overlay_style
            
        self.boundary = AsyncBoundary(delay=delay)
        self.container = None
        self.main_content = None
        self.overlay_container = None
        self.current_message = str(self.loading_content)
    
    def wrap(self, main_content: LayoutDOM) -> LayoutDOM:
        """Create a container that can switch between loading, error, and main content."""
        from bokeh.layouts import column
        
        self.main_content = main_content
        
        if self.loading_overlay:
            self.container = column(main_content, sizing_mode="stretch_both")
            self.overlay_container = None
            self.current_state = AsyncContainerState.MAIN
        else:
            loading_widget = self._get_loading_content()
            self.container = column(loading_widget, sizing_mode="stretch_both")
            self.current_state = AsyncContainerState.LOADING
        
        return self.container
    
    @property
    def is_loading(self) -> bool:
        return self.current_state == AsyncContainerState.LOADING or self.boundary.is_loading

    async def load_async(
        self,
        operation: Callable,
        runtime: DFDashboardRuntime,
        on_success: Optional[Callable] = None,
        loading_message: Optional[str] = None,
        **operation_kwargs
    ):
        if loading_message and self.loading_overlay:
            self.update_loading_message(loading_message)
        
        def show_loading(message):
            self._switch_to_loading()
        
        def handle_success(data):
            self._switch_to_main()
            if on_success:
                on_success(data)
        
        def handle_error(error_msg):
            self._switch_to_error(error_msg)
        
        await self.boundary.run(
            operation=operation,
            runtime=runtime,
            on_success=handle_success,
            on_error=handle_error,
            loading_callback=show_loading,
            **operation_kwargs
        )
    
    def update_loading_message(self, message: str):
        self.current_message = message
    
    def _get_loading_content(self) -> LayoutDOM:
        if callable(self.loading_content):
            return self.loading_content()
        elif isinstance(self.loading_content, str):
            message = self.current_message or self.loading_content
            if self.loading_overlay:
                return Div(
                    text=f'<div style="display: flex; align-items: center; gap: 10px; font-size: 14px; color: #666;">'
                         f'<span style="font-size: 18px;">{self.spinner_style}</span>'
                         f'<span>{message}</span>'
                         f'</div>',
                    styles={"text-align": "center", "padding": "20px"}
                )
            else:
                return Div(text=message, styles={"text-align": "center", "color": "gray"})
        else:
            return self.loading_content
    
    def _get_error_content(self, error_msg: str) -> LayoutDOM:
        if callable(self.error_content):
            return self.error_content(error_msg)
        elif isinstance(self.error_content, str):
            return Div(text=f"{self.error_content}: {error_msg}", styles={"text-align": "center", "color": "red"})
        else:
            return self.error_content
    
    def _switch_to_loading(self):
        if self.loading_overlay:
            if self.current_state != AsyncContainerState.LOADING:
                new_overlay = self._get_loading_content()
                new_overlay.styles = {
                    **self.overlay_style,
                    "display": "flex"
                }
                
                if hasattr(self.container, 'children'):
                    self.container.children = [self.main_content, new_overlay]
                    self.overlay_container = new_overlay
                
                if self.dim_content and self.main_content:
                    current_styles = getattr(self.main_content, 'styles', {})
                    self.main_content.styles = {
                        **current_styles,
                        "opacity": "0.6",
                        "pointer-events": "none"
                    }
                
                self.current_state = AsyncContainerState.LOADING
        elif self.container and self.current_state != AsyncContainerState.LOADING:
            loading_widget = self._get_loading_content()
            self.container.children = [loading_widget]
            self.current_state = AsyncContainerState.LOADING
    
    def _switch_to_main(self):
        if self.loading_overlay:
            if hasattr(self.container, 'children') and len(self.container.children) > 1:
                self.container.children = [self.main_content]

            if self.dim_content and self.main_content:
                current_styles = getattr(self.main_content, 'styles', {})
                styles_copy = dict(current_styles)
                styles_copy.pop("opacity", None)
                styles_copy.pop("pointer-events", None)
                self.main_content.styles = {
                    **styles_copy,
                    "opacity": "1",
                    "pointer-events": "auto"
                }
            
            self.overlay_container = None
            self.current_state = AsyncContainerState.MAIN
        elif self.container and self.main_content and self.current_state != AsyncContainerState.MAIN:
            self.container.children = [self.main_content]
            self.current_state = AsyncContainerState.MAIN
    
    def _switch_to_error(self, error_msg: str):
        if self.loading_overlay and self.overlay_container:
            error_widget = self._get_error_content(error_msg)
            error_widget.styles = {
                **self.overlay_style,
                "display": "flex",
                "background": "rgba(255, 240, 240, 0.9)"
            }
            if hasattr(self.container, 'children') and len(self.container.children) > 1:
                self.container.children = [self.main_content, error_widget]
                self.overlay_container = error_widget
            self.current_state = "error"
        elif self.container and self.current_state != "error":
            error_widget = self._get_error_content(error_msg)
            self.container.children = [error_widget]
            self.current_state = "error"


class SimpleAsyncLoader:
    """Simple async loader with lifecycle callbacks."""
    
    def __init__(self, delay: float = 0.1):
        self.delay = delay
        self.is_loading = False
    
    async def load(
        self,
        operation: Callable,
        runtime: DFDashboardRuntime,
        on_start: Optional[Callable] = None,
        on_success: Optional[Callable] = None,
        on_error: Optional[Callable] = None,
        **operation_kwargs
    ):
        if self.is_loading:
            return None
        
        self.is_loading = True
        
        try:
            if on_start:
                runtime.document.add_next_tick_callback(on_start)
            
            if self.delay > 0:
                await tornado.gen.sleep(self.delay)
            
            if asyncio.iscoroutinefunction(operation):
                result = await operation(runtime, **operation_kwargs)
            else:
                result = await runtime.io_loop.run_in_executor(None, lambda: operation(runtime, **operation_kwargs))
            
            if on_success:
                runtime.document.add_next_tick_callback(lambda: on_success(result))
            
            return result
            
        except Exception as e:
            error_msg = str(e)
            log.error(f"Async operation failed: {error_msg}")
            
            if on_error:
                runtime.document.add_next_tick_callback(lambda: on_error(error_msg))
            
            return None
            
        finally:
            self.is_loading = False


async def with_async_loading(
    operation: Callable,
    runtime: DFDashboardRuntime,
    on_success: Optional[Callable] = None,
    on_error: Optional[Callable] = None,
    on_loading: Optional[Callable] = None,
    delay: float = 0.1,
    **operation_kwargs
):
    """Convenience function for simple async operations with loading states."""
    loader = SimpleAsyncLoader(delay=delay)
    return await loader.load(
        operation=operation,
        runtime=runtime,
        on_start=on_loading,
        on_success=on_success,
        on_error=on_error,
        **operation_kwargs
    )
