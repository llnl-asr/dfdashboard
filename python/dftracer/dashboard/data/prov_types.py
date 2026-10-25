"""The provenance graph's shape, so a wrong key in it is a type error.

`build()` returns `ProvGraph`. The API serves it as is, and the SPA reads the
same fields, so this module is the one place the graph is described.
"""

from __future__ import annotations

from typing import Union

from typing_extensions import NotRequired, TypeAlias, TypedDict

Cell: TypeAlias = Union[int, float, str, None]


class Entity(TypedDict):
    hash: str
    id: str
    pids: list[int]
    store: str
    type: str
    uri: str


class EntityRelation(TypedDict):
    object: str
    relation: str
    subject: str


class ProvType(TypedDict):
    description: str
    name: str
    role: str


class Activity(TypedDict):
    activity: str
    aid: str
    cat: str
    dur: float
    generated: list[str]
    invalidated: list[str]
    name: str
    pid: int
    ts: float
    updated: list[str]
    used: list[str]


class ActivityAcc(Activity):
    """An activity while it is being read, before it is finished."""

    has_main: NotRequired[bool]
    nused: NotRequired[int]
    ngen: NotRequired[int]


class ProvFile(TypedDict):
    fhash: str
    mount: str
    path: str
    rel: str


class Mount(TypedDict):
    fstype: str
    path: str


class Access(TypedDict):
    aid: str
    bytes: int
    calls: int
    fhash: str
    op: str
    path: str


class EntityFile(TypedDict):
    entity: str
    fhash: str
    path: str


class ProvStats(TypedDict):
    activities: int
    cont_events: int
    dangling_hashes: int
    entities: int
    entity_records: int
    files: int
    files_excluded: int
    io_attributed: int
    io_events: int
    isolated_entities: int
    mounts: int
    orphan_chunks: int
    prov_events: int
    truncated_activities: int


class ProvGraph(TypedDict):
    entities: list[Entity]
    entity_relations: list[EntityRelation]
    types: list[ProvType]
    activities: list[Activity]
    files: list[ProvFile]
    mounts: list[Mount]
    accesses: list[Access]
    entity_files: list[EntityFile]
    stats: ProvStats


class ProvAcc(TypedDict):
    """What the scan accumulates: keyed by hash or name, finished at the end."""

    entities: dict[str, Entity]
    activities: dict[str, ActivityAcc]
    types: dict[str, ProvType]
    entity_relations: list[EntityRelation]
    stats: dict[str, int]
