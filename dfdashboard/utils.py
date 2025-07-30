from typing import Type, TypeVar
import inspect


def import_object(path: str):
    """
    Import any object from a dotted string path (e.g. 'module.ClassName').
    """
    module_path, attr = path.rsplit(".", 1)
    module = __import__(module_path, fromlist=[attr])
    return getattr(module, attr)

TSubClass = TypeVar("TSubClass")

def import_subclass(path: str, base_cls: Type[TSubClass]) -> Type[TSubClass]:
    """
    Import an object and ensure it's a subclass of `base_cls`.

    Returns:
        A class object guaranteed to be a subclass of base_cls (type-safe).
    Raises:
        TypeError if not a class or not a subclass.
    """
    obj = import_object(path)

    if not inspect.isclass(obj):
        raise TypeError(f"{path} does not refer to a class.")

    if not issubclass(obj, base_cls):
        raise TypeError(f"{path} is not a subclass of {base_cls.__name__}.")

    return obj
