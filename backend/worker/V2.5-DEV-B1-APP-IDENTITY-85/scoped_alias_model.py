"""Offline scoped alias-registry review model; synthetic only, no HMAC/SQL/D1."""
from dataclasses import dataclass
from threading import RLock

class IntegrityConflict(Exception): pass
class IncompleteKeyCoverage(Exception): pass
class ActiveKeySetDrift(Exception): pass

@dataclass(frozen=True)
class Scope:
    tenant_id: str
    owner_id: str
    dimension_type: str

@dataclass(frozen=True)
class Event:
    scope: Scope
    event_id: str
    action: str
    dimension_id: str
    occurred_at: int
    policy_window_id: str
    decision: str

class ScopedAliasRegistry:
    """Single-process oracle only; a process lock is not cross-Worker serialization."""
    def __init__(self, active_versions=("K1", "K2"), config_epoch="cfg-1"):
        if not active_versions or len(set(active_versions)) != len(active_versions):
            raise ValueError("active key versions must be unique and non-empty")
        self.active_versions = tuple(active_versions)
        self.config_epoch = config_epoch
        self.aliases = {}
        self.events = {}
        self.event_aliases = {}
        self.references = {}
        self.next_id = 0
        self.lock = RLock()

    def _check_epoch(self, versions, epoch):
        if tuple(versions) != self.active_versions or epoch != self.config_epoch:
            raise ActiveKeySetDrift("stale active-key-set/config epoch")

    def _resolve(self, scope, fingerprints, versions, epoch):
        self._check_epoch(versions, epoch)
        if set(fingerprints) != set(self.active_versions):
            raise IncompleteKeyCoverage("all active key aliases required")
        keys = [(scope.tenant_id, scope.owner_id, scope.dimension_type, v, fp)
                for v, fp in fingerprints.items()]
        mapped = {self.aliases[k] for k in keys if k in self.aliases}
        if len(mapped) > 1:
            raise IntegrityConflict("aliases split across dimension IDs")
        dimension_id = next(iter(mapped)) if mapped else None
        if dimension_id is None:
            self.next_id += 1
            dimension_id = "dim-%d" % self.next_id
        if any(k in self.aliases and self.aliases[k] != dimension_id for k in keys):
            raise IntegrityConflict("alias reassignment")
        return dimension_id, keys

    def admit(self, scope, event_id, action, fingerprints, occurred_at,
              policy_window_id, decision, versions=None, epoch=None):
        with self.lock:
            versions = self.active_versions if versions is None else tuple(versions)
            epoch = self.config_epoch if epoch is None else epoch
            dimension_id, keys = self._resolve(scope, fingerprints, versions, epoch)
            event_key = (scope.tenant_id, scope.owner_id, event_id)
            event = Event(scope, event_id, action, dimension_id, occurred_at,
                          policy_window_id, decision)
            old_event = self.events.get(event_key)
            if old_event is not None and old_event != event:
                raise IntegrityConflict("scoped event_id tuple conflict")
            aliases = {}
            for version, fingerprint in fingerprints.items():
                key = (scope.tenant_id, scope.owner_id, event_id, version, scope.dimension_type)
                old = self.event_aliases.get(key)
                if old is not None and old != fingerprint:
                    raise IntegrityConflict("event alias changed")
                aliases[key] = fingerprint
            # Assertions complete before mutations; this lock is process-local only.
            for key in keys:
                self.aliases[key] = dimension_id
            self.events[event_key] = event
            self.event_aliases.update(aliases)
            self.references.setdefault(dimension_id, set()).add(event_key)
            return event

    def set_writer_config(self, versions, epoch):
        with self.lock:
            if not versions or len(set(versions)) != len(versions):
                raise ValueError("invalid active key set")
            self.active_versions, self.config_epoch = tuple(versions), epoch

    def cleanup_event(self, scope, event_id, retention_expired, retry_closed,
                      outside_active_windows, backfill_complete):
        with self.lock:
            if not all((retention_expired, retry_closed, outside_active_windows, backfill_complete)):
                return False
            key = (scope.tenant_id, scope.owner_id, event_id)
            event = self.events.pop(key, None)
            if event is None:
                return False
            for alias_key in [k for k in self.event_aliases if k[:3] == key]:
                del self.event_aliases[alias_key]
            refs = self.references.get(event.dimension_id, set())
            refs.discard(key)
            if not refs:
                self.references.pop(event.dimension_id, None)
            # Dimension aliases remain reserved; alias retirement is a separate gated operation.
            return True
