#!/usr/bin/env python3
# 建「薪資醫院 → 48hr 暫留比率」對照表（手工 curated key，唯一命中才採用，絕不亂猜）
# 輸出 data/boarding-by-hospital.json = { 薪資醫院名: {ratio, official, level, quarter} }
import json, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
bd_doc = json.loads((ROOT/'data'/'boarding-latest.json').read_text())
bd = bd_doc['hospitals']; quarter = bd_doc['quarter']

SB='https://gjpvzqlsfimuqwditeqf.supabase.co'; KEY='sb_publishable_P0gPzbp1mg8pgYJumikvTg_RJj8PHYS'
req=urllib.request.Request(SB+'/rest/v1/dashboard_data?select=hospital',headers={'apikey':KEY,'Authorization':'Bearer '+KEY})
sal=[r['hospital'] for r in json.loads(urllib.request.urlopen(req,timeout=20).read())]

# 薪資名 → 48hr official name 裡的 distinctive 子字串（或完整官方名以消歧）
KEY = {
 '草屯佑民醫院':'佑民','竹山秀傳醫院':'竹山秀傳','埔里基督教醫院':'埔里基督教','台中榮總埔里分院':'埔里分院',
 '光田醫院':'光田綜合','衛福部豐原醫院':'豐原','部立台中醫院':'衛生福利部臺中醫院','台中慈濟醫院':'台中慈濟',
 '童綜合醫院':'童綜合醫療','台中市立老人復健綜合醫院':'老人復健','振興醫院':'振興醫院',
 '澄清醫院':'澄清綜合醫院中港分院',  # 台中中港路那家（多分院、需指定）
 '台北市立聯合醫院和平院區':'臺北市立聯合醫院','國泰醫院總院':'國泰醫療財團法人國泰綜合醫院',
 '馬偕醫院':'馬偕醫療財團法人馬偕紀念醫院','台北市立聯合醫院中興院區':'臺北市立聯合醫院',
 '部立台南醫院新化分院':'臺南醫院新化','台南郭綜合醫院':'郭綜合','成大醫院':'國立成功大學醫學院附設醫院','台南市立醫院':'台南市立醫院',
 '台東馬偕紀念醫院':'台東馬偕','台中榮總嘉義分院':'榮民總醫院嘉義分院','聖馬':'聖馬爾定','嘉義基督教醫院':'嘉義基督教',
 '羅東博愛醫院':'羅東博愛','宜蘭陽大附醫':'陽明交通大學','屏東枋寮醫院':'枋寮','屏東潮州安泰醫院':'潮州安泰',
 '屏東基督教醫院':'屏東基督教','枋寮醫院':'枋寮','員林基督教醫院':'員林基督教','彰濱秀傳醫院':'彰濱秀傳',
 '漢銘基督教醫院':'漢銘','樂生醫院':'樂生療養院','汐止國泰醫院':'汐止國泰','新北永和耕莘醫院':'永和',
 '衛福部台北醫院':'衛生福利部臺北醫院','輔大醫院':'輔仁大學','雙和醫院':'雙和','台大竹東分院':'竹東',
 '台北榮總新竹分院':'榮民總醫院新竹分院','臺大醫院新竹分院':'新竹臺大分院新竹醫院','中醫大新竹':'中國醫藥大學新竹',
 '中壢長榮醫院':'中壢長榮','楊梅天成醫院':'天成醫院','部立桃園醫院':'衛生福利部桃園醫院','桃園聖保祿醫院':'聖保祿',
 '聯新國際醫院':'聯新國際','台北榮總鳳林分院':'鳳林','台北榮總玉里分院':'榮民總醫院玉里分院','門諾醫院':'臺灣基督教門諾會醫療財團法人門諾醫院',
 '國軍花蓮總醫院':'國軍花蓮','為恭紀念醫院':'為恭','衛生福利部苗栗醫院':'苗栗醫院','虎尾若瑟醫院':'若瑟',
 '臺大醫院雲林分院':'臺灣大學醫學院附設醫院雲林分院','中醫北港':'北港','高雄市立民生醫院':'民生醫院',
 '高雄路竹秀傳醫院':'路竹','高醫岡山醫院':'高醫岡山醫院','高雄聖功醫院':'聖功',
}

out={}; ambiguous=[]; absent=[]; nokey=[]
for s in sal:
    k=KEY.get(s)
    if not k: nokey.append(s); continue
    exact=[h for h in bd if h['name']==k]
    sub=[h for h in bd if k in h['name']]
    pick = exact[0] if len(exact)==1 else (sub[0] if len(sub)==1 else None)
    if pick:
        out[s]={'ratio':pick['ratio'],'official':pick['name'],'level':pick['level'],'quarter':quarter}
    elif len(sub)>1:
        ambiguous.append((s,k,[h['name'] for h in sub]))
    else:
        absent.append((s,k))

doc={'meta':{'quarter':quarter,'quarterName':bd_doc.get('quarterName'),
              'nationalAvg':bd_doc.get('nationalAvg'),'source':bd_doc.get('source'),
              'matched':len(out),'salaryTotal':len(sal)},
     'hospitals':out}
(ROOT/'data'/'boarding-by-hospital.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2))
print(f"✅ 唯一命中 {len(out)} / {len(sal)} 家薪資醫院")
print(f"\n⚠️ 多命中需消歧 ({len(ambiguous)}):")
for s,k,c in ambiguous: print(f"  {s}（key={k}）→ {c}")
print(f"\n❌ 零命中需修 key ({len(absent)}):")
for s,k in absent: print(f"  {s}（key={k}）")
print(f"\n— 未建 key ({len(nokey)}): {nokey}")
