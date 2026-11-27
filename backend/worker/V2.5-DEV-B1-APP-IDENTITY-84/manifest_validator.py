"""Static checks for design-only statement manifests; never executes SQL."""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
EXPECTED={
 "identity_adapter-statement-manifest.json":"identity_adapter",
 "limiter_adapter-statement-manifest.json":"limiter_adapter",
 "disposable_harness-statement-manifest.json":"disposable_harness",
}
FORBIDDEN={"sql_text","sql","bind_values","secret","token","raw_nonce","raw_card_code"}
def validate_manifest(doc,expected_interface):
    if doc.get("interface")!=expected_interface: raise ValueError("interface mismatch")
    if doc.get("status")!="DESIGN_ONLY_NO_SQL": raise ValueError("manifest must remain design-only")
    if doc.get("manifest_version")!="1.0": raise ValueError("unsupported manifest version")
    policy=doc.get("policy")
    if not isinstance(policy,dict): raise ValueError("policy object required")
    if policy.get("production_sql_permitted") is not False: raise ValueError("production SQL must remain prohibited")
    if not isinstance(doc.get("statements"),list): raise ValueError("statements array required")
    seen=set()
    for statement in doc["statements"]:
        if not isinstance(statement,dict): raise ValueError("statement must be object")
        if FORBIDDEN.intersection(statement): raise ValueError("SQL or sensitive bind material forbidden")
        sid=statement.get("statement_id")
        if not isinstance(sid,str) or not sid or sid in seen: raise ValueError("statement_id missing or duplicated")
        seen.add(sid)
        if statement.get("sql_state")!="NOT_FROZEN": raise ValueError("SQL must remain not frozen")
        if statement.get("sql_sha256") is not None: raise ValueError("SQL hash forbidden before approval")
        if statement.get("placeholders")!=[] or statement.get("binds")!=[]:
            raise ValueError("placeholder/bind vectors must remain empty before SQL freeze")
    return True

def load_and_validate():
    for filename,interface in EXPECTED.items():
        doc=json.loads((ROOT/filename).read_text(encoding="utf-8"))
        validate_manifest(doc,interface)
    return len(EXPECTED)

if __name__=="__main__":
    print("validated %d design-only manifests" % load_and_validate())
