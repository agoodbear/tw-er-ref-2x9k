"""build_boarding_map.py 比對邏輯的離線測試（不連 Supabase）。

執行：cd scripts && python3 -m unittest discover -s test -p 'test_*.py'
"""
import importlib.util
import json
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

spec = importlib.util.spec_from_file_location('build_boarding_map', HERE.parent / 'build_boarding_map.py')
bbm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bbm)  # 有 main guard，import 不會連網或寫檔


def H(name, ratio=1.0, level='區域醫院'):
    return {'name': name, 'ratio': ratio, 'level': level}


class MatchHospitalsTest(unittest.TestCase):
    def test_import_has_no_side_effect(self):
        self.assertTrue(callable(bbm.main))
        self.assertTrue(callable(bbm.match_hospitals))

    def test_exact_name_wins_over_multiple_substring(self):
        bd = [H('振興醫院', 2.0), H('振興醫院附設分院', 9.0)]
        out, amb, absent, nokey = bbm.match_hospitals(['振興'], bd, {'振興': '振興醫院'})
        self.assertEqual(out['振興']['ratio'], 2.0)
        self.assertEqual(amb, [])

    def test_unique_substring(self):
        bd = [H('醫療財團法人羅東博愛醫院', 3.1), H('臺北榮民總醫院', 1.0)]
        out, *_ = bbm.match_hospitals(['羅東博愛醫院'], bd, {'羅東博愛醫院': '羅東博愛'})
        self.assertEqual(out['羅東博愛醫院']['official'], '醫療財團法人羅東博愛醫院')

    def test_multiple_substring_is_ambiguous_not_guessed(self):
        bd = [H('臺北市立聯合醫院仁愛院區'), H('臺北市立聯合醫院中興院區')]
        out, amb, absent, nokey = bbm.match_hospitals(['聯醫中興'], bd, {'聯醫中興': '臺北市立聯合醫院'})
        self.assertEqual(out, {})
        self.assertEqual(amb[0][0], '聯醫中興')
        self.assertEqual(len(amb[0][2]), 2)

    def test_zero_match_is_absent(self):
        out, amb, absent, nokey = bbm.match_hospitals(['A'], [H('B')], {'A': '不存在'})
        self.assertEqual(absent, [('A', '不存在')])

    def test_no_key(self):
        out, amb, absent, nokey = bbm.match_hospitals(['沒建key'], [H('x')], {})
        self.assertEqual(nokey, ['沒建key'])

    def test_duplicate_exact_falls_back_to_substring_then_ambiguous(self):
        bd = [H('同名醫院'), H('同名醫院')]
        out, amb, *_ = bbm.match_hospitals(['s'], bd, {'s': '同名醫院'})
        self.assertEqual(out, {})
        self.assertEqual(len(amb), 1)


class BuildDocTest(unittest.TestCase):
    def setUp(self):
        self.bd_doc = json.loads((ROOT / 'data' / 'boarding-latest.json').read_text())
        self.committed = json.loads((ROOT / 'data' / 'boarding-by-hospital.json').read_text())

    def test_reproduces_committed_mapping(self):
        # 以已 commit 的對照表當「已知會命中的薪資醫院」，重算結果必須一模一樣（離線回歸測試）
        sal = list(self.committed['hospitals'].keys())
        doc, amb, absent, nokey = bbm.build_doc(self.bd_doc, sal)
        self.assertEqual(doc['hospitals'], self.committed['hospitals'])
        self.assertEqual(doc['meta']['matched'], len(sal))
        self.assertEqual(doc['meta']['quarter'], self.bd_doc['quarter'])

    def test_output_key_order(self):
        sal = list(self.committed['hospitals'].keys())[:1]
        doc, *_ = bbm.build_doc(self.bd_doc, sal)
        self.assertEqual(list(doc.keys()), ['meta', 'hospitals'])
        self.assertEqual(list(next(iter(doc['hospitals'].values())).keys()), ['ratio', 'official', 'level', 'quarter'])

    def test_every_name_key_value_hits_at_least_once(self):
        # NAME_KEY 的子字串至少要在本季 48hr 名單出現一次；全部落空代表 key 該修
        names = [h['name'] for h in self.bd_doc['hospitals']]
        dead = [k for k in set(bbm.NAME_KEY.values()) if not any(k in n for n in names)]
        # 允許少數醫院該季未申報，但不能大量失效
        self.assertLessEqual(len(dead), 5, f'失效的 NAME_KEY：{dead}')


if __name__ == '__main__':
    unittest.main()
