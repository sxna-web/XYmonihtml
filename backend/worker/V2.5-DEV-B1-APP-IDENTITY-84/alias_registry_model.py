"""Concurrent alias-registry reference model. Synthetic only; no HMAC, SQL, D1 or production policy."""
from dataclasses import dataclass
from threading import RLock

class IntegrityConflict(Exception): pass
class IncompleteKeyCoverage(Exception): pass
class UnsafeRetirement(Exception): pass

@dataclass(frozen=True)
class LogicalEvent:
    event_id: str
    action: str
    dimension_type: str
    dimension_id: str
    occurred_at: int
    policy_window_id: str
    decision: str

class AliasRegistry:
    """Idealized atomicity via one process lock; not a D1 transaction proof."""
    def __init__(self, active_versions=("K1","K2")):
        self.active_versions=tuple(active_versions)
        self.dimension_aliases={}
        self.events={}
        self.event_aliases={}
        self.backfill_covered=set()
        self.lock=RLock()

    def resolve_dimension(self, dimension_type, fingerprints):
        with self.lock:
            if set(fingerprints) != set(self.active_versions):
                raise IncompleteKeyCoverage("all active key-version aliases are required atomically")
            aliases=[(v,dimension_type,fp) for v,fp in fingerprints.items()]
            mapped={self.dimension_aliases[a] for a in aliases if a in self.dimension_aliases}
            if len(mapped)>1:
                raise IntegrityConflict("aliases resolve to multiple logical dimension IDs")
            dimension_id=next(iter(mapped)) if mapped else f"dim-{len(self.dimension_aliases)+1}"
            for alias in aliases:
                prior=self.dimension_aliases.get(alias)
                if prior is not None and prior != dimension_id:
                    raise IntegrityConflict("alias uniqueness conflict")
            for alias in aliases:
                self.dimension_aliases[alias]=dimension_id
            return dimension_id

    def admit_event(self,event_id,action,dimension_type,fingerprints,
                    occurred_at,policy_window_id,decision):
        with self.lock:
            dimension_id=self.resolve_dimension(dimension_type,fingerprints)
            event=LogicalEvent(event_id,action,dimension_type,dimension_id,
                               occurred_at,policy_window_id,decision)
            prior=self.events.get(event_id)
            if prior is not None and prior != event:
                raise IntegrityConflict("event_id reused with a different logical tuple")
            aliases={(event_id,v,dimension_type):fp for v,fp in fingerprints.items()}
            for key,fp in aliases.items():
                old=self.event_aliases.get(key)
                if old is not None and old != fp:
                    raise IntegrityConflict("event/key-version alias changed")
            self.events[event_id]=event
            self.event_aliases.update(aliases)
            return event

    def count_union(self,lookups):
        with self.lock:
            matched=set()
            for (event_id,version,dimension_type),fp in self.event_aliases.items():
                if lookups.get((version,dimension_type))==fp:
                    matched.add(event_id)
            return len(matched),matched

    def mark_backfilled(self,event_id):
        with self.lock:
            if event_id not in self.events:
                raise IntegrityConflict("cannot backfill unknown event")
            self.backfill_covered.add(event_id)

    def verify_backfill_coverage(self,required_event_ids,new_version,
                                 retry_horizon_closed,rollback_horizon_closed):
        with self.lock:
            if not (retry_horizon_closed and rollback_horizon_closed):
                return False
            if not required_event_ids.issubset(self.backfill_covered):
                return False
            for event_id in required_event_ids:
                event=self.events.get(event_id)
                if event is None: return False
                if (event_id,new_version,event.dimension_type) not in self.event_aliases:
                    return False
            return True

    def retire_key(self,old_version,new_version,required_event_ids,
                   retry_horizon_closed,rollback_horizon_closed,cleanup_horizon_closed):
        with self.lock:
            if not (retry_horizon_closed and rollback_horizon_closed and cleanup_horizon_closed):
                raise UnsafeRetirement("retry/rollback/cleanup horizons are still open")
            if not self.verify_backfill_coverage(required_event_ids,new_version,True,True):
                raise UnsafeRetirement("new-key alias coverage is incomplete")
            if old_version not in self.active_versions:
                raise UnsafeRetirement("old key is not active")
            self.active_versions=tuple(v for v in self.active_versions if v!=old_version)
            return self.active_versions

    def cleanup_event(self,event_id,retention_expired,retry_horizon_closed,
                      outside_all_active_windows,backfill_complete):
        with self.lock:
            if not all((retention_expired,retry_horizon_closed,
                        outside_all_active_windows,backfill_complete)):
                return False
            self.events.pop(event_id,None)
            for key in [k for k in self.event_aliases if k[0]==event_id]:
                del self.event_aliases[key]
            return True
