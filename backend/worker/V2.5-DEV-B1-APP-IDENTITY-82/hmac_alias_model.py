"""Synthetic HMAC key-version alias model; no cryptography, D1 or production policy."""
from dataclasses import dataclass

class IntegrityConflict(Exception):
    pass

@dataclass(frozen=True)
class LogicalEvent:
    event_id: str
    action: str
    dimension_type: str
    dimension_ref: str  # opaque test identity, not a production fingerprint
    occurred_at: int
    policy_window_id: str
    decision: str

class AliasLedger:
    def __init__(self):
        self.events = {}
        self.aliases = {}  # (event_id, key_version, dimension_type) -> fingerprint

    def write(self, event, version_fingerprints):
        prior = self.events.get(event.event_id)
        if prior is not None and prior != event:
            raise IntegrityConflict("logical event tuple changed")
        for version, fingerprint in version_fingerprints.items():
            key = (event.event_id, version, event.dimension_type)
            old = self.aliases.get(key)
            if old is not None and old != fingerprint:
                raise IntegrityConflict("same event/key-version alias changed")
        self.events[event.event_id] = event
        for version, fingerprint in version_fingerprints.items():
            self.aliases[(event.event_id, version, event.dimension_type)] = fingerprint

    def count_union(self, lookups):
        matched = set()
        for (event_id, version, dimension_type), fingerprint in self.aliases.items():
            if lookups.get((version, dimension_type)) == fingerprint:
                matched.add(event_id)
        return len(matched), matched

    def coverage(self, event_ids, version):
        return all(
            any(eid == event_id and v == version for (eid, v, _), _fp in self.aliases.items())
            for event_id in event_ids
        )

    def retire_allowed(self, old_version, new_version, event_ids, retry_horizon_closed):
        return retry_horizon_closed and self.coverage(event_ids, new_version)

    def cleanup_event(self, event_id, retention_expired, retry_horizon_closed,
                      outside_all_active_windows):
        if not (retention_expired and retry_horizon_closed and outside_all_active_windows):
            return False
        self.events.pop(event_id, None)
        for key in [k for k in self.aliases if k[0] == event_id]:
            del self.aliases[key]
        return True
