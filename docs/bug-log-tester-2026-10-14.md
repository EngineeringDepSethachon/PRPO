# ผลเทสต์จากผู้ทดสอบ (Thanawut S.) — 2026-10-14

ที่มา: `Bug_log_PRPO.xlsx` ชีต "Test Cases" (9 เคส Fail ทั้งหมด) ทดสอบบน production https://prpo-pdqc.pages.dev
ชีต "Bug Log" ในไฟล์เดียวกันยังเป็นข้อมูลตัวอย่างของเทมเพลต (ตะกร้าสินค้า/บัตรเครดิต) ไม่เกี่ยวกับระบบนี้ ไม่ต้องทำ
หมายเหตุ: ไฟล์ต้นฉบับมีรหัสผ่านของผู้ทดสอบในช่อง Test Data ห้ามคัดลอกต่อ และควรเปลี่ยนรหัสนั้น

| TC | ระดับ | โมดูล | อาการ (จากผู้ทดสอบ) | สาเหตุเบื้องต้น / จุดในโค้ด (Claude ตรวจ 14 ต.ค.) |
|---|---|---|---|---|
| TC-001 | Critical | PO PDF | ลายเซ็น "ผู้ขอซื้อ" ใน PDF เป็น System Admin ไม่ใช่ผู้ขอซื้อของ PR/PO นั้น | `src/utils/generatePoPdf.js:670-671` เลือกผู้เซ็นช่องผู้ขอซื้อจาก **บทบาท** (`users.find(roleId==='REQUESTER_PD') || ...includes('REQUESTER') || users[0]`) ไม่ใช่จาก `pr.requesterId/requesterName` → ถ้าไม่มีผู้ใช้บทบาทนั้นตก `users[0]` = admin ; เป็นพฤติกรรมเดิม GAS ("ลายเซ็นตาม role") → **ต้องให้ผู้ใช้ตัดสิน**: ใช้ลายเซ็นของผู้ขอซื้อตัวจริง (ตามที่ผู้ทดสอบคาด) หรือคงตาม role |
| TC-002 | Medium | รับเข้าสินค้า (GRN) | แนบรูปพัสดุในฟอร์มตรวจรับแล้วกดดูรูปเต็ม ไม่แสดง | น่าจะเคสเดียวกับที่แก้วันนี้ใน `ImageLightboxModal` (รูป R2/blob ไม่ถูกส่ง fileId) — ตรวจ `ReceivingModal.jsx` ส่วน preview รูปที่เพิ่งแนบ (blob:) และรูปที่บันทึกแล้ว (/api/files) ว่าส่ง object เต็มเข้า lightbox หรือไม่ |
| TC-003 | Critical | เคลม / รับบางส่วน | เลือก "บันทึกปัญหาไว้ก่อน (รอประสานงานร้านค้า)" แล้วไม่มีทางไปต่อ (เลือกส่งเพิ่ม/คืนเงิน/ยอมรับสภาพภายหลังไม่ได้) และ task รอเคลมไปโผล่ที่ Reviewer แทน Requester | `ReceivingModal.jsx:1091-1111` ตั้ง status/claimStatus = `PENDING_CLAIM` ; ต้องมีปุ่มใน `PODetailsModal` ("แก้ไขเคลม / ติดตามเคลม") ที่เปิดได้สำหรับสถานะนี้ให้ Requester เลือกแนวทางต่อ ; การ route งานไป Reviewer ดูที่ `workspaceService.js` (กฎ To-Do ของสถานะ PENDING_CLAIM) |
| TC-004 | High | คลังสินค้า: หมายเหตุสินค้า (Product Remark) | บันทึกแล้วขึ้นว่าเรียบร้อย แต่ข้อมูลไม่ถูกเก็บ | เคสเดียวกับ S1: `src/components/stock/ProductRemarkDrawer.jsx` บันทึกลง storageService (localStorage) อย่างเดียว ไม่ยิง API ; ต้องเพิ่มการบันทึกฟิลด์หมายเหตุของสินค้าผ่าน PUT /api/products/:id (หรือ route ใหม่) |
| TC-005 | High | แจ้งเตือน | กระดิ่งมีตัวเลข badge แต่กดแล้วไม่มีรายการ | `Sidebar.jsx:410` badge = `taskCounts.total` (จำนวนงานค้าง ตามที่ตัดสินใน S5) แต่รายการใน popover (`Sidebar.jsx:632`) มาจาก `notificationService.getNotificationsForRole()` ที่กรองด้วย `isNotificationTarget(n, currentRole)` — แถวจาก server (`recipientRole`/targetDept) อาจไม่ตรงเงื่อนไขกรองของ client จึงว่าง ; ต้องตรวจรูปแบบข้อมูลแจ้งเตือนจาก bootstrap กับตัวกรอง และตัดสินว่า badge ควรนับอะไร **→ สาเหตุจริง (2026-10-15): `/api/bootstrap` ฝั่ง CF ไม่ส่ง `notifications` เลย (GAS ส่ง) และ client ไม่เรียก GET /api/notifications เอง ; แก้แล้ว deploy prod** |
| TC-006 | Critical | เคลมออนไลน์ | หลัง Online Purchaser ดำเนินการเคลมเสร็จ task ควรมาที่ To-Do ของ Requester แต่ไปอยู่ "รอผู้อื่นดำเนินการ" | กฎ To-Do ใน `workspaceService.js` สำหรับสถานะหลังเคลมออนไลน์ (เช่น `WAITING_DELIVERY_ROUND_2` / claim resolved) ไม่ถือว่าเป็นงานของ Requester |
| TC-007 | Critical | เบิกจ่ายด่วน: สถิติการใช้งาน | แท็บสถิติไม่มียอดเบิก ; ประวัติรายการไม่แสดงวันเวลาและจำนวน | หน้า QuickIssue (`src/views/inventory/*`) อ่าน stock log จาก localStorage/ฟิลด์ชื่อเดิม ขณะที่ server ส่ง `stock_logs` ชื่อฟิลด์ D1 (`createdAt`, `quantity`, `type`) ; ต้องแมปฟิลด์ (เหมือนที่ทำ alias ให้ products ใน D-2) |
| TC-008 | Critical | เบิกจ่ายด่วน: ต้นทุนเฉลี่ย | หน้าจอโชว์ต้นทุนเฉลี่ย 134.29 แต่ตัดสต็อกจริงที่ 100/หน่วย (ราคาตั้งต้น) และไม่แสดงวันเวลา | server `/api/stock/issue` (`[[route]].js:4384`) ใช้ `products.avgCost || standardPrice` ; ปุ่ม "คำนวณต้นทุนเฉลี่ยใหม่" คำนวณฝั่ง client จาก log แล้ว**ไม่บันทึกลง D1** → server ยังเห็น avgCost เดิม ; แนวแก้: ให้ server คำนวณ MAC จาก stock_logs ตอนเบิก หรือให้ปุ่มคำนวณบันทึก avgCost ผ่าน API (และตรวจว่า GRN อัปเดต avgCost ครบทุกเส้นทาง) |
| TC-009 | Critical | จัดซื้อออนไลน์: ปิดงานหลังเคลม | PO ออนไลน์ที่มีเคลม เมื่อ Requester รับของเสร็จและ PO เป็นสำเร็จ แต่การ์ดใน Online Hub ไม่ย้ายไปแท็บ "ปิดงานสำเร็จ" | `OnlineProcurementHub.jsx` จัดแท็บจากสถานะ PO/claimStatus ; สถานะหลังเคลมจบ (เช่น `COMPLETED` + claimStatus ค้าง `REPLACEMENT_PENDING/RESOLVED`) ไม่เข้าเงื่อนไขแท็บปิดงาน |

| TC-010 | Critical | รับของเพิ่มจากการเคลม (ออนไลน์) | หลังจัดซื้อออนไลน์จัดการเคลมเสร็จ (ส่งทดแทน) Requester กดตรวจรับรอบ 2 ไม่ได้ (Bug_log_PRPO (2).xlsx, 2026-10-15) | ฟอร์มเปิดได้ แต่ตอนยืนยัน `ReceivingModal` ส่ง PUT status `WAITING_DELIVERY_ROUND_2 → COMPLETED` ถูก `rbac.PO_CLAIM_OPEN` (กฎปิดเคลม 03a483c) ปฏิเสธ 403 สำหรับ Requester ที่ไม่ใช่เจ้าของ PR **→ แก้แล้ว: ถอด ROUND_2 ออกจากชุดเคลมค้าง deploy prod 2026-10-15** |

| TC-011 | High | เปิด PR | ผู้ใช้ที่ดูแล 2 แผนกขึ้นไป (Asst. Manager ขึ้นไป) เปิด PR ได้แค่แผนกเดียว (Bug_log_PRPO (3).xlsx, 2026-10-15) | `PRCreateView` ล็อกแผนกเป็น `currentRole.department` เว้นแต่ 'ALL' **→ แก้แล้ว: dropdown จากแผนกที่ผู้ใช้ดูแล (getUserDepartments) deploy prod 2026-10-15** |

## ลำดับที่แนะนำ
1. TC-008 + TC-007 (ตัวเลขสต็อก/ต้นทุนผิด = ข้อมูลเสีย) และ TC-004 (บันทึกหาย)
2. TC-003, TC-006, TC-009 (สายเคลมค้างกลางทาง ทั้งภายในและออนไลน์ ควรแก้เป็นชุดเดียวใน workspaceService + PODetailsModal + OnlineProcurementHub)
3. TC-005 (แจ้งเตือน), TC-002 (รูป GRN)
4. TC-001 รอผู้ใช้ตัดสินเรื่องลายเซ็น

ทุกข้อควรมีเทสต์ (vitest หรือ e2e cf) จับอาการตามที่ผู้ทดสอบเขียน และให้ QA ทดสอบซ้ำกับ flow เต็มของเคลมทั้งสองแบบ
