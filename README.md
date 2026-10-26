# Testable Tools (VS Code extension)

Extension นี้ทำ Testable REST API ให้เป็น tool ใน Copilot agent mode โดยลอกชื่อและ schema มาจาก MCP server ของ Testable (`https://mcp.testable.io`) แต่**ไม่ใช้ MCP และไม่ใช้ `@modelcontextprotocol/sdk`** ตอน runtime ไม่มี dependency ใดๆ มีแค่ VS Code Language Model Tools API กับ `fetch` ไปที่ `https://api.testable.io`

ผลของ tool กลุ่ม workflow แสดงเป็นหน้า UI ในแชทได้ (คล้าย MCP Apps) ผ่าน chat output renderer ของ VS Code ซึ่งยังเป็น proposed API ต้องเปิดก่อน ดูหัวข้อ [เปิด UI ในแชท](#เปิด-ui-ในแชท)

## Tool ที่ Copilot เห็น

### Workflow (มี UI ในแชท)

| Tool | หน้าที่ |
|---|---|
| `testable_showTests` | test case, scenario และ configuration ของ repo นี้ (กรองตาม git remote ถ้า API key อ่าน VCS root ได้) พร้อมบอกว่าใช้ key ไหน และ org อื่นมี test case ของ repo นี้ด้วยไหม |
| `testable_showScenario` | settings, declared params, ไฟล์, repository และ configuration ของ scenario |
| `testable_downloadExecution` | โหลด `logs.txt`, `failures.txt` (test ที่ fail พร้อม stack trace), `failed-tests.json`, `execution.json` และ output files ลง `.testable/executions/<id>/` ให้ agent อ่านต่อ |
| `testable_pullScenarioFiles` | โหลดไฟล์ของ scenario ลง `.testable/scenarios/<id>-<name>/` (ไม่ทับไฟล์ที่แก้ในเครื่อง) |
| `testable_pushScenarioFiles` | อัปโหลดไฟล์ที่แก้แล้วกลับขึ้นไป (update ไฟล์เดิม, create ไฟล์ใหม่, ไม่ลบ) |
| `testable_updateScenarioSettings` | แก้ settings ของ scenario เช่น `chromedriverOnly`, `seleniumVersion`, `browsers.edge` (ชื่อ key ต้องมีอยู่แล้ว กันพิมพ์ผิด) |
| `testable_setScenarioParams` | ตั้งหรือลบ scenario params (env var) ของ configuration |
| `testable_updateRepository` | สลับ branch ที่ scenario ใช้ (`branch` ของ scenario ไม่ใช่ของ root) หรืออัปเดต token ของ VCS root ที่หมดอายุ |

Tool ที่เขียนข้อมูลจะแสดงค่าก่อนและหลังให้ยืนยันก่อนเสมอ ส่วน token ของ VCS ใส่ในช่อง password ของ VS Code โดยตรง ไม่ผ่านแชท และจะถูกทดสอบกับ repo ก่อนบันทึก ถ้าทดสอบไม่ผ่าน (เช่น repo อยู่หลัง firewall ที่ต้องรันผ่าน self-hosted runner) เลือก Save Anyway ได้

### Generic

| Tool | หน้าที่ |
|---|---|
| `testable_searchTools` | ค้นหา operation จาก keyword |
| `testable_describeTools` | ดู schema เต็มของ operation |
| `testable_callTool` | เรียก operation ไหนก็ได้ใน catalog (172 ตัว) |
| `testable_<operation>` 12 ตัว | operation ที่ใช้บ่อย ประกาศตรงพร้อม schema |

Operation แบบ write (POST/PUT/DELETE) จะแสดงกล่องยืนยันพร้อม endpoint และ argument ก่อนส่ง

Mapping ของ argument เหมือนของ Testable: `path_x` ใส่ใน `:x` ของ path, `query_x` เป็น `?x=` และ field อื่นทั้งหมดเป็น JSON body

Testable ใส่ API key ไว้ใน URL ที่ส่งกลับมา (`...?key=...`) extension จะลบออกก่อนส่งข้อความให้ model

## ติดตั้งและใช้งาน

1. ติดตั้ง `testable-tools-0.1.0.vsix` ผ่าน Extensions → `...` → Install from VSIX
2. รันคำสั่ง **Testable: Add API Key** (key จะเก็บใน SecretStorage ของ VS Code)
3. เปิด Copilot Chat ในโหมด Agent แล้วกดเปิด tool ที่ขึ้นต้นด้วย Testable

### หลาย API key (หลาย org)

เพิ่ม key ได้หลายตัวด้วย **Testable: Add API Key** ตอนเพิ่ม extension จะเช็ค key กับ Testable ก่อนแล้วให้ตั้งชื่อ (ค่าเริ่มต้นเป็น `Org <id>` เพราะ API key อ่านชื่อ org ไม่ได้)

แต่ละ workspace ใช้ key ได้ทีละตัว ถ้ามี key มากกว่าหนึ่งตัวและยังไม่ได้เลือกให้ workspace นี้ ตอนเรียก Testable ครั้งแรก extension จะเช็ค git remote ของ workspace กับทุก key แล้วเลือก org ที่มี test case ผูกกับ repo นี้และรันล่าสุด จากนั้นแจ้งว่าเลือก key ไหนเพราะอะไร

- ชื่อ key ที่ workspace ใช้แสดงที่ status bar ด้านล่าง (แสดงเมื่อมีมากกว่าหนึ่ง key) กดเพื่อเปลี่ยน
- **Testable: Select API Key** แสดงทุก key พร้อม test case ที่ผูกกับ repo นี้และวันเวลาที่รันล่าสุด เลือก key ให้ workspace นี้ เปลี่ยนชื่อ หรือลบได้จากรายการนี้
- หน้า Testable มีส่วน **API keys · this repo** ที่บอกเหมือนกัน ถ้า org อื่นมี test case ของ repo นี้ที่รันใหม่กว่า (เช่นเคยสร้างไว้ผิด org) จะขึ้นเตือนพร้อมปุ่ม Use
- หน้าที่เปิดค้างไว้ในแชทหรือ dashboard จะใช้ key เดิมที่โหลดหน้านั้นมา แม้ workspace จะเปลี่ยนไปใช้ key อื่นแล้ว
- **Testable: Remove API Key** ลบ key ออก

key จากเวอร์ชันก่อนที่มีแค่ตัวเดียวจะย้ายมาเป็น key ชื่อ `Default` ให้อัตโนมัติ

**Testable: Open Dashboard** เปิดหน้าเดียวกันใน editor tab ได้ ไม่ต้องใช้ proposed API

Settings: `testable.apiUrl` (ค่าเริ่มต้น `https://api.testable.io`), `testable.maxResponseChars` (ค่าเริ่มต้น 60000) และ `testable.localFolder` (ค่าเริ่มต้น `.testable` ในโฟลเดอร์ workspace แรก มี `.gitignore` ให้อัตโนมัติ)

## เปิด UI ในแชท

VS Code Stable ให้ใช้ proposed API เฉพาะ extension ที่ระบุไว้เท่านั้น แม้จะรันใน extension development mode ก็ตาม

1. Command Palette → **Preferences: Configure Runtime Arguments** (เปิด `argv.json`)
2. เพิ่ม `"enable-proposed-api": ["local.testable-tools"]`
3. ปิด VS Code ทุกหน้าต่างแล้วเปิดใหม่

ถ้ายังไม่ได้เปิด tool จะยังใช้ได้ตามปกติแต่ตอบเป็นข้อความอย่างเดียว และ extension จะแจ้งเตือนครั้งเดียวพร้อมปุ่มเปิด `argv.json` ใน VS Code บางเวอร์ชัน proposed API อาจเปลี่ยน ถ้า UI ในแชทหายไปหลังอัปเดต ให้ดู log ใน Output → Testable Tools

## ที่ใช้ไม่ได้ (25 ตัว)

Tool เหล่านี้ทำงานอยู่ใน MCP server ของ Testable เอง (`/internal/*`) ไม่มี REST endpoint สาธารณะ:
`run_smoke_test`, `browser_*`, `make_http_request`, attachment/conversation tools, `resolve_openfin_version`, `describe_tools`, `search_tools`
ส่วน `uploadScenarioFiles` และ `replaceScenarioFiles` ใช้ `createScenarioFileFromContents` หรือ `updateScenarioFileContents` แทน
`encode_base64` และ `decode_base64` ทำงานใน extension เอง

API key ของ Testable อ่านรายการ `/vcs-roots` ไม่ได้ (HTTP 401) แต่อ่าน root ทีละตัวได้ การกรองตาม git remote จึงดูจาก VCS root ที่ scenario ผูกไว้ ถ้าไม่มี scenario ไหนผูกกับ repo ของ workspace จะแสดงทุก test case

## อัปเดต catalog เมื่อ Testable เพิ่ม tool

```sh
npm run discover   # ใช้ TESTABLE_API_KEY ใน .env ดึง tools/list + describe_tools -> discovery/tools.json
npm run generate   # สร้าง src/catalog.json และ languageModelTools ใน package.json
npm run compile
npm run smoke      # ยิง GET แบบอ่านอย่างเดียวไปที่ API จริงด้วย key ใน .env (ไฟล์ที่โหลดลง temp แล้วลบทิ้ง)
npm run package
```

รายชื่อ tool ที่ประกาศตรงแก้ได้ที่ `DIRECT` ใน `scripts/generate.mjs` ส่วนคำอธิบาย tool กลุ่ม workflow อยู่ใน `workflowTools` ไฟล์เดียวกัน
