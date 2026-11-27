import unittest
from manifest_validator import validate_manifest, load_and_validate

def sample(interface="identity_adapter"):
    return {"manifest_version":"1.0","interface":interface,"status":"DESIGN_ONLY_NO_SQL",
            "policy":{"production_sql_permitted":False},"statements":[]}

class ManifestValidationTests(unittest.TestCase):
    def test_01_three_repository_manifests_valid(self): self.assertEqual(load_and_validate(),3)
    def test_02_wrong_interface_rejected(self):
        with self.assertRaises(ValueError): validate_manifest(sample("limiter_adapter"),"identity_adapter")
    def test_03_execution_state_rejected(self):
        d=sample(); d["status"]="READY"
        with self.assertRaises(ValueError): validate_manifest(d,"identity_adapter")
    def test_04_production_sql_permission_rejected(self):
        d=sample(); d["policy"]["production_sql_permitted"]=True
        with self.assertRaises(ValueError): validate_manifest(d,"identity_adapter")
    def test_05_raw_sql_field_rejected(self):
        d=sample(); d["statements"]=[{"statement_id":"id.read","sql_text":"SELECT 1"}]
        with self.assertRaises(ValueError): validate_manifest(d,"identity_adapter")
    def test_06_bind_values_rejected(self):
        d=sample(); d["statements"]=[{"statement_id":"id.read","bind_values":["secret"]}]
        with self.assertRaises(ValueError): validate_manifest(d,"identity_adapter")
    def test_07_sql_hash_before_approval_rejected(self):
        d=sample(); d["statements"]=[{"statement_id":"id.read","sql_state":"NOT_FROZEN","sql_sha256":"a"*64,"placeholders":[],"binds":[]}]
        with self.assertRaises(ValueError): validate_manifest(d,"identity_adapter")
    def test_08_nonempty_placeholder_vectors_rejected(self):
        d=sample(); d["statements"]=[{"statement_id":"id.read","sql_state":"NOT_FROZEN","sql_sha256":None,"placeholders":[1],"binds":[]}]
        with self.assertRaises(ValueError): validate_manifest(d,"identity_adapter")
    def test_09_duplicate_statement_ids_rejected(self):
        s={"statement_id":"id.read","sql_state":"NOT_FROZEN","sql_sha256":None,"placeholders":[],"binds":[]}
        d=sample(); d["statements"]=[s,s]
        with self.assertRaises(ValueError): validate_manifest(d,"identity_adapter")
if __name__=="__main__": unittest.main()
