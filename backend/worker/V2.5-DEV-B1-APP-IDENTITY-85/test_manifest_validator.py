import unittest
from manifest_validator import validate_manifest,load_and_validate
def sample():
 return {"manifest_version":"1.1","interface":"identity_adapter","status":"DESIGN_ONLY_NO_SQL","policy":{"production_sql_permitted":False},"statements":[]}
def statement():
 return {"statement_id":"id.lookup","owner":"IdentityAdapter","method":"resolve","purpose":"resolve scoped identity","result_contract":{},"error_contract":{},"receipt_dependencies":["receipt.lookup"],"audit_dependencies":["audit.append"],"assertion_dependencies":["assert.owner"],"sql_state":"NOT_FROZEN","sql_sha256":None,"placeholders":[],"binds":[]}
class ManifestTests(unittest.TestCase):
 def test_repository_manifests(self): self.assertEqual(load_and_validate(),3)
 def test_complete_statement_metadata(self):
  d=sample();d["statements"]=[statement()];self.assertTrue(validate_manifest(d,"identity_adapter"))
 def test_missing_audit_dependency_rejected(self):
  d=sample();s=statement();del s["audit_dependencies"];d["statements"]=[s]
  with self.assertRaises(ValueError):validate_manifest(d,"identity_adapter")
 def test_production_sql_rejected(self):
  d=sample();d["policy"]["production_sql_permitted"]=True
  with self.assertRaises(ValueError):validate_manifest(d,"identity_adapter")
 def test_sql_text_and_private_key_rejected(self):
  d=sample();s=statement();s["sql_text"]="SELECT 1";d["statements"]=[s]
  with self.assertRaises(ValueError):validate_manifest(d,"identity_adapter")
  d=sample();s=statement();s["private_key"]="x";d["statements"]=[s]
  with self.assertRaises(ValueError):validate_manifest(d,"identity_adapter")
 def test_hash_and_bind_material_rejected(self):
  d=sample();s=statement();s["sql_sha256"]="a"*64;d["statements"]=[s]
  with self.assertRaises(ValueError):validate_manifest(d,"identity_adapter")
  d=sample();s=statement();s["binds"]=["secret"];d["statements"]=[s]
  with self.assertRaises(ValueError):validate_manifest(d,"identity_adapter")
if __name__=="__main__":unittest.main()
