from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js"


def scheduled_block(source: str) -> str:
    marker = "async scheduled(event, env, ctx) {"
    start = source.find(marker)
    if start < 0:
        raise AssertionError("scheduled() entrypoint missing")
    # These assertions deliberately inspect the bounded scheduled-method tail.
    end = source.find("\n  },\n};", start)
    if end < 0:
        raise AssertionError("scheduled() method boundary missing")
    return source[start:end]


def main() -> None:
    source = WORKER.read_text(encoding="utf-8")
    subprocess.run(["node", "--check", str(WORKER)], check=True)
    block = scheduled_block(source)

    forbidden = "if (!sources.length) return;"
    if forbidden in block:
        raise AssertionError("Cron still exits before lifecycle maintenance when no sources exist")

    maintenance = [
        "await runVipCardMaintenance(db, cronCtx)",
        "await runNodeLifecycle(db, cronCtx)",
        "await runEntitlementMaintenance(db)",
    ]
    positions = [block.find(item) for item in maintenance]
    if any(pos < 0 for pos in positions) or positions != sorted(positions):
        raise AssertionError("Cron maintenance calls missing or out of order")

    sync_guard = block.find("if (sources.length)")
    sync_call = block.find("await runSync(db, sources")
    if sync_guard < 0 or sync_call < sync_guard:
        raise AssertionError("runSync must be conditional on sources.length")
    if not (positions[-1] < sync_guard):
        raise AssertionError("Lifecycle/entitlement maintenance must precede optional runSync")

    print("PASS: Worker syntax")
    print("PASS: Cron maintenance executes before optional source synchronization")
    print("PASS: no-source Cron does not early-return")


if __name__ == "__main__":
    main()
