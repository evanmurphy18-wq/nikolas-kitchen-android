"""Set monotonically increasing versionCode and semantic versionName in Capacitor Gradle source."""
import re, sys, json
from pathlib import Path
p=Path(sys.argv[1]); code=40000+int(sys.argv[2]); tag=sys.argv[3]
version=tag[1:] if tag.startswith('v') and re.match(r'^v\d+\.\d+\.\d+$',tag) else json.loads(Path('package.json').read_text())['version']
s=p.read_text()
# Capacitor 8 generates a Groovy android/app/build.gradle with these fields.
s,n1=re.subn(r'\bversionCode\s+\d+',f'versionCode {code}',s,count=1)
s,n2=re.subn(r'\bversionName\s+"[^"]+"',f'versionName "{version}"',s,count=1)
assert n1==1 and n2==1, 'Gradle layout changed: update versioning script'
p.write_text(s)
print('Android version:',version,'versionCode:',code)
