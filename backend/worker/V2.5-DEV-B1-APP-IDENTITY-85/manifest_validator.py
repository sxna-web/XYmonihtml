"""Static checks for design-only statement manifests; never executes SQL."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
EXPECTED={"identity_adapter-statement-manifest.json":"identity_adapter","limiter_adapter-statement-manifest.json":"limiter_adapter","disposable_harness-statement-manifest.json":"disposable_harness"}
FORBIDDEN={"sql_text","sql","bind_values","secret","token","raw_nonce","raw_card_code","private_key","credential","raw_fingerprint"}
REQUIRED={"statement_id","owner","method","purpose","result_contract","error_contract","receipt_dependencies","audit_dependencies","assertion_dependencies","sql_state","sql_sha256","placeholders","binds"}
def validate_manifest(doc, interface):
    if doc.get("interface")!=interface or doc.get("status")!="DESIGN_ONLY_NO_SQL" or doc.get("manifest_version")!="1.1": raise ValueError("manifest identity/status/version invalid")
    policy=doc.get("policy")
    if not isinstance(policy,dict) or policy.get("production_sql_permitted") is not False: raise ValueError("production SQL must remain prohibited")
    if not isinstance(doc.get("statements"),list): raise ValueError("statements array required")
    seen=set()
    for s in doc["statements"]:
        if not isinstance(s,dict) or FORBIDDEN.intersection(s): raise ValueError("statement or sensitive SQL material invalid")
        if not REQUIRED.issubset(s): raise ValueError("statement metadata incomplete")
        sid=s["statement_id"]
        if not isinstance(sid,str) or not sid or sid in seen: raise ValueError("statement_id missing/duplicate")
        seen.add(sid)
        for k in ("owner","method","purpose"):
            if not isinstance(s[k],str) or not s[k].strip(): raise ValueError(k+" required")
        for k in ("receipt_dependencies","audit_dependencies","assertion_dependencies"):
            if not isinstance(s[k],list) or any(not isinstance(x,str) or not x for x in s[k]): raise ValueError(k+" invalid")
        if not isinstance(s["result_contract"],dict) or not isinstance(s["error_contract"],dict): raise ValueError("result/error contract invalid")
        if s["sql_state"]!="NOT_FROZEN" or s["sql_sha256"] is not None or s["placeholders"]!=[] or s["binds"]!=[]: raise ValueError("SQL and bind vectors must remain blank")
    return True
def load_and_validate():
    for name,interface in EXPECTED.items(): validate_manifest(json.loads((ROOT/name).read_text()),interface)
    return len(EXPECTED)
if __name__=="__main__": print("validated %d design-only manifests"%load_and_validate())
