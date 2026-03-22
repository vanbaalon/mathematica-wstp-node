#!/usr/bin/env python3
import urllib.request, json, subprocess

cred = subprocess.run(
    ['git', 'credential', 'fill'],
    input='protocol=https\nhost=github.com\n',
    capture_output=True, text=True,
    cwd='/Users/k0959535/Dropbox/MY/Programming/VSCodeWolframExtension/WSTP Backend'
)
token = ''
for line in cred.stdout.splitlines():
    if line.startswith('password='):
        token = line.split('=', 1)[1].strip()

if not token:
    print('No GitHub token found via git credential helper')
else:
    headers = {'Authorization': f'token {token}', 'Accept': 'application/vnd.github.v3+json'}

    req = urllib.request.Request(
        'https://api.github.com/repos/vanbaalon/mathematica-wstp-node/actions/runs?per_page=6',
        headers=headers)
    runs = json.loads(urllib.request.urlopen(req).read()).get('workflow_runs', [])
    print('=== Workflow runs ===')
    for r in runs:
        print(f"  {r['status']:12} {(r.get('conclusion') or '-'):10} {r['head_sha'][:7]}  {r['name']}  {r['created_at']}")

    req2 = urllib.request.Request(
        'https://api.github.com/repos/vanbaalon/mathematica-wstp-node/releases?per_page=3',
        headers=headers)
    rels = json.loads(urllib.request.urlopen(req2).read())
    print('\n=== Releases ===')
    for rel in rels:
        assets = [a['name'] for a in rel.get('assets', [])]
        print(f"  {rel['tag_name']:10}  assets: {assets or '(none yet)'}")
