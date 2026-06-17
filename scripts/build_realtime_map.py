#!/usr/bin/env python3
# 建「薪資醫院 → 即時資料醫院簡稱」對照表（給散點圖 button 2：即時待床）
# 前端會用這張表去 congestion-latest.json 即時 join 該院 wait_admit（等待住院＝待床）。
# 只收薪資醫院 == 即時 59 家急救責任醫院 的同一家；不同分院/不同院一律不收。
import json, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
cong = json.loads((ROOT/'data'/'congestion-latest.json').read_text())['hospitals']
cong_names = {h['name'] for h in cong}
cmap = {h['name']: h for h in cong}

SB='https://gjpvzqlsfimuqwditeqf.supabase.co'; KEY='sb_publishable_P0gPzbp1mg8pgYJumikvTg_RJj8PHYS'
req=urllib.request.Request(SB+'/rest/v1/dashboard_data?select=hospital',headers={'apikey':KEY,'Authorization':'Bearer '+KEY})
sal=[r['hospital'] for r in json.loads(urllib.request.urlopen(req,timeout=20).read())]

# 薪資名 → 即時簡稱（手工，同一家醫院才對）
MAP = {
 '振興醫院':'振興','國泰醫院總院':'台北國泰','馬偕醫院':'台北馬偕','童綜合醫院':'童綜合',
 '台中慈濟醫院':'台中慈濟','成大醫院':'成大醫院','臺大醫院新竹分院':'臺大新竹','嘉義基督教醫院':'嘉基',
 '衛福部台北醫院':'部立臺北','輔大醫院':'輔大','部立桃園醫院':'部立桃園','宜蘭陽大附醫':'陽交大附醫',
 '羅東博愛醫院':'博愛','為恭紀念醫院':'為恭','彰濱秀傳醫院':'彰濱秀傳','臺大醫院雲林分院':'臺大雲林',
 '屏東基督教醫院':'屏基','台東馬偕紀念醫院':'台東馬偕','雙和醫院':'部立雙和','光田醫院':'向上光田',
}
out={}; bad=[]
for s,rt in MAP.items():
    if s not in sal: bad.append((s,rt,'薪資查無此名')); continue
    if rt not in cong_names: bad.append((s,rt,'即時查無此名')); continue
    out[s]=rt
(ROOT/'data'/'realtime-namemap.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
print(f"✅ 即時對照 {len(out)} 家")
print("各家目前待床(等待住院):")
for s,rt in out.items():
    print(f"  {s} → {rt}：待床 {cmap[rt]['wait_admit']}")
if bad: print("⚠️ 有問題:", bad)
