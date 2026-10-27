# Changelog

บันทึกสิ่งที่เปลี่ยนในแต่ละเวอร์ชัน เลขเวอร์ชันใช้ [Semantic Versioning](https://semver.org/) วิธีออกเวอร์ชันดูที่ [README](README.md#ออกเวอร์ชันใหม่)

## Unreleased

ทดสอบกับ VS Code 1.143

### เพิ่ม

- tool ที่เรียก Testable รับ argument `apiKey` เป็นชื่อ key เพื่อดูข้อมูลของ org อื่นได้โดยไม่ต้องสลับ key ของ workspace
- หาด้วย ID แล้ว key ของ workspace ได้ 401/403/404 จะลอง key ที่เหลือต่อ และบอก model ว่าเจอใน key ไหน
- `apiKey: "all"` ยิง list และ search ระดับ org ด้วยทุก key แล้วแยกผลตาม org
- ไอคอน extension, ไอคอนของ tool ที่อ่านข้อมูล, แท็บ Dashboard และหน้าในแชทใช้โลโก้และสีของ Testable (ธีม high contrast ยังใช้สีของธีม)

### เปลี่ยน

- tool ที่เขียนข้อมูลไม่สลับ key เองและไม่รับ `"all"` ถ้ามีหลาย key กล่องยืนยันจะบอกว่าจะเขียนลง key ไหน
- ชื่อ `all` สงวนไว้ ตั้งเป็นชื่อ key ไม่ได้
- หน้า tests ติด **in use** ที่ key ของ workspace แม้หน้านั้นจะโหลดด้วย key อื่น

## 0.1.0 — 2026-10-26

- Testable REST API เป็น tool ใน Copilot agent mode โดยไม่ใช้ MCP: tool กลุ่ม workflow 8 ตัวที่มีหน้า UI ในแชท, `testable_searchTools` / `testable_describeTools` / `testable_callTool` สำหรับ catalog 172 operation และ operation ที่ใช้บ่อย 12 ตัว
- **Testable: Open Dashboard** เปิดหน้าเดียวกันใน editor tab
- หลาย API key เก็บใน SecretStorage แต่ละ workspace ใช้ key ที่เลือกไว้ หรือ key ของ org ที่มี test case ผูกกับ git remote ของ repo และรันล่าสุด
