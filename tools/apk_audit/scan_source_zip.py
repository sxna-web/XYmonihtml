import hashlib,re,sys,zipfile
from pathlib import Path
from urllib.parse import urlparse

ARCHIVES=["StarJump-6.00.47-source .zip","StarJump-6.00.48-source.zip"]
SUFFIXES={".gradle",".kts",".properties",".xml",".java",".kt",".json",".yaml",".yml",".toml",".txt",".md",".pro",".cfg",".conf",".sh"}
RULES={
"license_activation":r"licen[cs]e|activat|trial|entitlement|授权码",
"device_binding":r"device.?id|android.?id|serial.?number|fingerprint|install.?id",
"remote_control":r"kill.?switch|remote.?disable|remote.?config|feature.?flag|heartbeat",
"third_party_api":r"base.?url|api.?url|https?://|websocket|wss?://",
"update":r"update.?url|in.?app.?update|version.?check|download.?url",
"telemetry":r"firebase|analytics|telemetry|crashlytics|sentry|bugly",
"payment_subscription":r"billing|purchase|payment|subscription|iap",
"privacy_collection":r"advertising.?id|collect.?device|upload.?log|report.?event",
}
URL=re.compile(r'https?://[^\s\"\'<>]+',re.I)
out=["# 星跃 APP 源码 ZIP 自动静态盘点报告","","> 自动化辅助审计，不构成许可证法律意见、完整安全审计或动态测试证明。",""]
for filename in ARCHIVES:
 p=Path(filename);out += ["## "+filename]
 if not p.exists():out.append("- 文件不存在");continue
 raw=p.read_bytes();out += ["- bytes: "+str(len(raw)),"- SHA-256: "+hashlib.sha256(raw).hexdigest()]
 try:
  z=zipfile.ZipFile(p);bad=z.testzip();infos=[i for i in z.infolist() if not i.is_dir()]
  out += ["- ZIP integrity: "+("PASS" if bad is None else "FAIL: "+bad),"- entries: "+str(len(infos)),"- file list (first 500):"]
  out += ["  - "+i.filename+" ("+str(i.file_size)+" bytes)" for i in infos[:500]]
  licenses=[i.filename for i in infos if re.search(r'(^|/)(license|licence|copying|notice|third.?party)',i.filename,re.I)]
  out += ["- license candidates:"]+["  - "+x for x in licenses or ["none obvious; absence is not proof"]]
  manifests=[i.filename for i in infos if i.filename.lower().endswith("androidmanifest.xml")]
  out += ["- AndroidManifest candidates:"]+["  - "+x for x in manifests or ["none found"]]
  hits={k:[] for k in RULES};hosts=set();deps=set();count=0
  for i in infos:
   if Path(i.filename).suffix.lower() not in SUFFIXES or i.file_size>2000000:continue
   try:t=z.read(i).decode("utf-8",errors="ignore")
   except:continue
   count+=1
   for n,line in enumerate(t.splitlines(),1):
    for k,pat in RULES.items():
     if re.search(pat,line,re.I):hits[k].append(i.filename+":"+str(n))
    for u in URL.findall(line):
     host=urlparse(u.rstrip("),;]")).hostname
     if host:hosts.add(host.lower())
    if Path(i.filename).suffix.lower() in {".gradle",".kts"}:
     deps.update(re.findall(r'(?:(?:implementation|api|compileOnly|runtimeOnly|classpath)\s*\(?\s*["\'])([^"\']+:[^"\']+:[^"\']+)',line))
  out += ["- text files scanned (max 2 MB each): "+str(count),"- dependency coordinates:"]+["  - "+x for x in sorted(deps) or ["none extracted"]]
  out += ["- URL hostnames (paths/query omitted):"]+["  - "+x for x in sorted(hosts) or ["none found"]]
  out += ["- keyword hit locations (path:line only; source lines suppressed):"]
  for k,v in hits.items():
   out.append("  - "+k+": "+str(len(v)))
   out += ["    - "+x for x in v[:80]]
   if len(v)>80:out.append("    - ... "+str(len(v)-80)+" more")
 except zipfile.BadZipFile:out.append("- invalid or corrupt ZIP")
 except Exception as e:out.append("- scan error type: "+type(e).__name__)
 out.append("")
out += ["## Limitations","- Does not execute source, APK, or Gradle scripts.","- Reads ZIP entries without extracting files to disk.","- Keyword hits are review leads; no hit does not prove absence.","- Obfuscated/native/encrypted/runtime-loaded code and server-side restrictions may evade static scanning.","- License conclusions require reading each license/NOTICE and any commercial agreement; critical network behavior requires isolated dynamic testing."]
Path("apk-source-audit-report.md").write_text("\n".join(out),encoding="utf-8")
print("Audit report generated.")
