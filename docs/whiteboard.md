<!--
รูปแบบ (อย่าเปลี่ยนชื่อหัวข้อ ## ทั้ง 4):
- บรรทัด "อัปเดต: YYYY-MM-DD HH:mm" ต้องอัปเดตทุกครั้งที่แก้
- ✅ ตัดสินใจแล้ว: รายการขึ้นต้น [YYYY-MM-DD]
- Milestone = "### M<n>: ชื่อ" ตามด้วย checkbox "- [ ]" / "- [x]"
- progress = จำนวน [x] / ทั้งหมด (server คำนวณ)
-->
# ไวท์บอร์ด Migrate Team
อัปเดต: 2026-10-16 09:00

## ✅ ตัดสินใจแล้ว

- [2026-10-16] ผู้ใช้สั่งปล่อยใช้งานจริงที่ https://prpo-pdqc.pages.dev และล้างข้อมูลทดสอบ (Neo ทำแล้ว): backup C:\Users\Admin\prpo-backups\prpo-db-20261015-pre-reset.sql ; ลบ PR/PO/สต็อก/งบ/แจ้งเตือน/audit/ไฟล์แนบ+R2 8 ไฟล์/ตัวนับ/สินค้า/ผู้ขาย/ลายเซ็น และผู้ใช้ทุกคนยกเว้น admin ; เก็บแผนก (PD, QC) สถานที่เก็บ 1 หน่วยนับ 4 ; admin ได้รหัสชั่วคราว (ไฟล์นอก repo, mustChangePassword=1, token เก่าใช้ไม่ได้) ; แนวทางพัฒนาต่อ: แก้ → npm test → deploy preview (prpo-db-preview) → ทดสอบ → deploy main

- [2026-10-15] TC-011 ปิด: หน้าเปิด PR ให้เลือกแผนกได้ทุกแผนกที่ผู้ใช้ดูแล (getUserDepartments: allowedDepartments/assignedDepartments/primary) ไม่ล็อกแค่แผนกหลัก ; 'ALL'/'*' = ทุกแผนก active ; แผนกเดียว/โหมดแก้ไขยังล็อก ; deploy prod แล้ว

- [2026-10-15] TC-010 ปิด: WAITING_DELIVERY_ROUND_2 ไม่ใช่ "เคลมค้าง" (เคลมจบแล้ว รอของทดแทน) ถอดออกจาก rbac.PO_CLAIM_OPEN → Requester ทุกคนที่รับของได้ ยืนยันตรวจรับรอบ 2 (→ COMPLETED) ได้ ; กฎจำกัดปิดเคลมยังคงใช้กับ CLAIM_REPORTED/CLAIM_IN_PROGRESS/CLAIM_PENDING/PARTIALLY_RECEIVED_IN_CLAIM ; deploy prod แล้ว

- [2026-10-15] ขยาย "เจ้าของเคลม" (กฎปิด PO ที่ติดเคลม 2026-10-14): ผู้ที่ตรวจรับและแจ้งเคลม (reportedBy/reportedById ใน claimData/claimDetails/storeClaims) นับเป็นเจ้าของด้วย นอกจากผู้ขอซื้อของ PR — เคส PO-PD-2026-003 (PR โดยกัลยาณี, เคลมโดยสิรภัทร) ; ทำทั้ง server poOwnerCtx และ PODetailsModal ; deploy prod แล้ว

- [2026-10-15] PODetailsModal: admin นับเป็น operational สำหรับปุ่มท้ายหน้าต่าง (ตรวจรับ / แจ้งปัญหา / จัดการเคสปัญหา) ตามคำตัดสิน 2026-10-14 ที่ให้ admin ปิดเคลมได้ (ผู้ทดสอบเปิด PO-PD-2026-003 เป็น admin แล้วไม่มีปุ่ม) ; deploy prod แล้ว

- [2026-10-15] กระดิ่ง badge = จำนวนแจ้งเตือนยังไม่อ่าน (unreadBadgeCount) แทน taskCounts.total — กลับคำตัดสิน S5 ข้อ A เพราะผู้ใช้แจ้งว่า badge 1 กับรายการ 13 ไม่สอดคล้อง ; งานค้างยังมี badge ที่ "งานของฉัน" ; ถอด runMacMigration('ถุงมือกันร้อน') ที่ App.jsx เรียกทุกครั้งตอนเปิดแอป (เด้ง NOT_FOUND บน CF) ; deploy prod แล้ว

- [2026-10-15] TC-005 follow-up ปิด: /api/bootstrap (CF) ต้องส่ง `notifications` เหมือน GAS (ใช้ extra.js listNotificationsFor ร่วมกับ GET /api/notifications) ; client ไม่เรียก GET เอง → ถ้า bootstrap ไม่ส่ง รายการกระดิ่งจะว่างบนเครื่องใหม่ ; deploy prod แล้ว (commit 8223212, npm test 2235/2235)

- [2026-10-14] **ผู้ใช้ตัดสิน (ผ่าน Claude):** (1) TC-001 ลายเซ็น "ผู้ขอซื้อ" ใน PDF PO ให้ใช้ลายเซ็นของ**ผู้ขอซื้อตัวจริงของ PR นั้น** (pr.requesterId/requesterName) ไม่ใช่เลือกตาม role/users[0] ; ถ้าผู้ขอซื้อยังไม่มีลายเซ็น ให้เว้นช่องว่างพร้อมชื่อ ไม่ fallback เป็นคนอื่น (2) ช่องโหว่กลางของกล้า: การเปลี่ยน PO ที่ค้างเคลมเป็น COMPLETED/CLOSED (และ short-close S4) ให้**จำกัดฝั่ง server** เหลือ Requester เจ้าของ PO/PR, Approver (level>=3) และ Admin เท่านั้น (`rbac.js canTransitionPO`) — Neo แตกงานให้ malee → QA → kla (แก้บั๊ก/ปิดช่องโหว่ ไม่ต้อง consult) ; deploy รอบล่าสุด 53b4af21 + migration 0017 แล้ว (commit eeb0902)

- [2026-10-14] M9 ปิดครบ (ผ่าน QA+kla, npm test 2225/2225, build ผ่าน): TC-005 แจ้งเตือนจาก server (serverScoped) ไม่กรองซ้ำที่ client, badge = งานค้าง ตาม 1.0.1 (ผู้ใช้เลือก A), badge กับ To-Do ใช้ src/utils/claimState.js ร่วม ; TC-002 AttachmentViewerModal รู้จัก R2 (/api/files) ไม่ตีความ uuid เป็น Drive ; /api/products/batch ไม่เขียน currentStock แถวเดิม + ไม่ปลุกแถวที่ลบ ; ยอดตั้งต้นสินค้าใหม่ตรวจ ≥0 ≤1e7 + audit PRODUCT_CREATE + trim code ; ค้นแถวสินค้า ORDER BY (id=?) DESC ; isDriveUrl/getDriveFileViewUrl ตรวจ hostname ; ก่อน deploy apply ถึง 0017

- [2026-10-14] TC-003/006/009 ปิด (ผ่าน QA, npm test 2145/2145): ปุ่ม 'จัดการเคสปัญหา' เปิดสำหรับ PARTIALLY_RECEIVED_IN_CLAIM/PENDING_CLAIM (isSelfClaimStatus) ; To-Do เคลมจัดซื้อเอง = Requester (L1) + Admin (Neo ตัดสินตามใบบั๊ก ; Reviewer ยังกดปุ่มได้ตาม server เดิม) ; resolveClaim ล้าง flag ค้าง (hasUnresolvedClaim/isInClaim/hasDispute) ; ROUND_2 = งาน Requester ; Hub สถานะปิดชนะ flag ค้าง (ยกเว้น storeClaims ยังไม่ resolve) ; client เท่านั้น

- [2026-10-14] TC-008/007/004 ปิด (ผ่าน QA+kla, npm test 2128/2128, build ผ่าน): ราคาเบิก/ปรับยอดคำนวณที่ server (avgCost > ราคา IN ล่าสุด > standardPrice ไม่หาร conversion ตาม GAS) เมิน unitCost จาก client ; หน้าจอโหมด CF ใช้เกณฑ์เดียวกัน (จับ log id/code) ; ปุ่มคำนวณ MAC ใหม่โหมด CF เรียก /api/products/recalculate-mac (ไม่รับ averageCost จาก client) ; stock_logs ส่ง alias timestamp/date/qty/note (functions/_lib/stocklogs.js) ; หมายเหตุสินค้าเก็บ D1 (migration 0017 remark) + audit PRODUCT_REMARK_SET ; PUT/POST สินค้าแถวเดิมไม่เขียน currentStock (server เป็นเจ้าของยอด) ; ก่อน deploy apply ถึง 0017

- [2026-10-14] ผู้ใช้สั่งแก้ docs/bug-log-tester-2026-10-14.md ลำดับ TC-008 > TC-007 > TC-004 > สายเคลม (TC-003/006/009) > TC-005 > TC-002 ; TC-001 รอผู้ใช้ตัดสิน (แก้บั๊ก ไม่ต้อง consult)

- [2026-10-14] S8 ปิด (ผ่าน QA+kla): stock_logs รับของมี grnNumber + แถว IN_NG (ไม่แตะยอด/MAC) เพดานชำรุดต่อคำขอ = ยอดสั่ง×conv − IN ดีสะสม ; grnNumber แถวเก่าเติมตอนอ่าน ; stockOnly ที่ PO ยังไม่ปิด → audit GOODS_RECEIVED_PARTIAL + แจ้งเตือน PO_CLAIM (ตามคำตัดสิน S8) ; PO ไม่มีแผนกไม่ส่งแจ้งเตือน

- [2026-10-14] S6/S7 ปิด (ผ่าน QA+kla): โหมด CF รูปสินค้าต่อรายการ+รูปแนบรวมอัปโหลด R2 เก็บ fileId (/api/files/:id), base64 เก่ายังแสดง ; ฟอร์ม PR ล้างตอนกด 'ตกลง' ใน modal สำเร็จ + กันส่งซ้ำ

- [2026-10-14] ผู้ใช้เลือก (ask) S8 แทน Q3 เดิม: ตรวจรับในโหมด CF ตรง GAS ตามที่ทำงานจริง — รับบางส่วน/มีเคลม ลง audit GOODS_RECEIVED_PARTIAL + แจ้งเตือน PO_CLAIM (จัดซื้อ+ผู้ขอ) ; รับครบไม่ลง/ไม่แจ้ง (ข้อมูล Q3 เดิมไม่ครบ)

- [2026-10-14] S3/S4 ปิด (ผ่าน QA+kla + ทดสอบ wrangler/D1 local): ReceivingModal remainingQty = min(ค่าเก็บ, สั่ง−รับ−คืนเงิน) → รอบ 2 รับครบเป็น COMPLETED ไม่บังคับฟอร์มเคลม ; ป้ายสถานะ PO/PR ใช้ label เดิม ; server cascade PR → completed ทันทีที่ PO ใดปิด (ตรง GAS Code.gs:2900-2947, poNumber ทับ, match ด้วย prId ก่อน) ใน batch + audit PR_COMPLETED_BY_PO (สงวน action) ; client CF ไม่ cascade ซ้ำ

- [2026-10-14] ผู้ใช้เลือก (ask) S4: ปิด PR ทันทีที่ PO ใบใดใบหนึ่งรับครบ/ปิด ตรง GAS เดิม (ไม่รอ PO พี่น้อง)

- [2026-10-14] S5 ปิด (ผ่าน QA+kla): คืนกระดิ่ง+NotificationPopover แบบ 1.0.1 ที่ Sidebar ข้างปุ่มรีเฟรช, badge = taskCounts.total (งานค้าง) ตาม 1.0.1, mark read ส่ง server ครั้งเดียว

- [2026-10-14] ผู้ใช้เลือก (ask) S5: คืนกระดิ่ง + หน้าต่างแจ้งเตือนแบบเวอร์ชัน 1.0.1 (c12ce08) ที่มุม Sidebar ข้างปุ่มรีเฟรช (เดิมถูกถอดใน b7b69c6 ก่อนทีมย้าย)

- [2026-10-14] ผู้ใช้สั่งทำต่อ S3 + S4 + S5 (แก้บั๊ก ไม่ต้อง consult)

- [2026-10-14] S1 ปิด (ผ่าน QA+kla + ทดสอบ wrangler/D1 local): route ใหม่ POST /api/stock/adjust และ /api/stock/manual-in — server คำนวณยอด+stock_logs+audit ใน batch, กันติดลบใน SQL, requestId กันซ้ำ (hash), สิทธิ์ STOCK_ADJUST = admin หรือ (ไม่ online และ ผู้รับของ L1/99 หรือ ASST_MANAGER), qty ปัด 4 ตำแหน่ง ≤1e7 (ใช้กับ /api/stock/issue ด้วย), rate limit 30/นาที ; ไม่ปรับ MAC (ฟอร์มไม่มีราคา ตาม mock เดิม) ; migration 0015 index audit_logs ; ก่อน deploy apply ถึง 0015

- [2026-10-14] S2 ปิด (QA ไม่ผ่าน 3 รอบ → ผู้ใช้อนุมัติแก้รอบ 4 ; ผ่าน QA+kla): BudgetView canAllocateBudget ตัดสิน admin ด้วย isAdminUser (adminRule.js) ก่อนเช็ค canOnlinePurchase ; โหมด CF ข้ามเงื่อนไข admin หลวม (canonicalRole/role/username/auth.isAdmin/canAccess) ; mock/GAS คงเดิม ; server บังคับสิทธิ์งบเองทุก route

- [2026-10-14] ผู้ใช้สั่งแก้ S1 + S2 จาก docs/smoke-test-2026-10-14.md ก่อน (แก้บั๊ก ไม่ต้อง consult)

- [2026-10-14] ผู้ใช้เลือก (ask): รัน M2 เองตาม docs/M2_RUNBOOK.md แล้วแจ้งผลทีละขั้น ; ทีมรอผล ไม่รันคำสั่ง remote ; เมื่อได้ผลแต่ละขั้น Neo ตรวจผลแล้วติ๊ก M2

- [2026-10-13] หลัง smoke r2 (ผ่าน QA+kla): ยอดงบ 960 vs 1,070 ไม่ใช่บั๊ก (สคริปต์ API ข้ามขั้น client ; หน้าจอตรงกันทุกขั้น ; budgets.totalUsed ไม่ใช้แสดงผล ตรง GAS) ; server ส่งเวลา D1 เป็น ISO-Z (functions/_lib/timefmt.js) + client แสดงเวลาไทยรูปแบบเดิม ; ledger แผนก normalize ด้วย ledgerDeptCode ตัวเดียวทั้งตรวจ/บันทึก (dept=department เสมอ) ; PO สถานะ COMPLETED แสดง 'เสร็จสิ้น' ; login เร็วไม่ใช่บั๊กแอป

- [2026-10-13] M7 ปิดครบ (ผ่าน QA+kla ทุกข้อ): smoke รอบ 2 docs/smoke-test-2026-10-13-r2.md 5 role 78/78, e2e cf 12/12, npm test 2025 ผ่าน, build ผ่าน ; หน้า Audit Log ซ่อน PR_UPSERT/STOCK_LOG (เก็บในฐาน) ; PUT /api/users ไม่ส่ง allowedDepartments รีเซ็ตแผนก = พฤติกรรมเดิม GAS

- [2026-10-13] M7-2 ผ่าน QA+kla: server สร้างแจ้งเตือนตาม GAS (functions/_lib/notify.js, ข้อความตรงตัวอักษร, targetDept จาก DB, ใน batch เดียวกับเอกสาร) ; สถานะอ่านแยกต่อคน notification_reads (แถวเก่า status='read' = อ่านแล้วทุกคน) ; POST /api/notifications เฉพาะ ADMIN ; PR เขียนทับมี guard สถานะ (AND status IS ?) แพ้ race → 409 หรือ 200 no-op ; ก่อน deploy apply migrations ถึง 0014

- [2026-10-13] ผู้ใช้เลือก: คงไม่แจ้งเตือน Approver ตอนส่งจากร่าง/ส่งใหม่ (ตรง GAS) และไม่เพิ่มป้ายแยกแถว audit จาก client

- [2026-10-13] M7-1/3/4 ผ่าน QA+kla: GET /api/audit-logs field ตาม GAS (admin เท่านั้น, module pr/po=PURCHASE อื่นตาม moduleMap client) ; POST audit-logs จาก client ห้าม pr/po และ action ที่ server สงวน + timeline อ่านเฉพาะ source IS NULL ; PO audit PO_CREATED/UPDATE_PO/GOODS_RECEIVED_*/PO_SETTLED ใน batch ; RESUBMIT 1 แถวผ่าน marker จาก client ; ล้างลายเซ็นถึง D1 + signerOf fallback ตาม GAS ; CSV export กัน formula

- [2026-10-13] ผู้ใช้เลือก (ask) ตามที่ทีมแนะนำ M7: RESUBMIT 1 แถวต่อครั้ง ; UPDATE_PO ลงทุกการแก้ PO ; รับของ stockOnly ไม่ลง audit/แจ้งเตือน (ตาม GAS) (แทนที่ด้วยคำตัดสิน S8 2026-10-14) ; สถานะอ่านแจ้งเตือนเก็บ server แยกต่อคน (ตาราง notification_reads migration 0014) ; ลายเซ็น: แก้การล้าง + fallback ตาม role ตาม GAS ไม่ทำหน้าใหม่ ; หน้า Audit Log แสดงข้อมูลจริงจาก server หน้าตาเดิม ; คงเมนูงบให้ ONLINE_PURCHASER (พฤติกรรมเดิม)

- [2026-10-13] Fable อนุมัติ M7 (cmv6sec6q1ce40) ลำดับ audit-log admin > PO audit > ลายเซ็น+RESUBMIT > แจ้งเตือน > smoke รอบ 2 ; local เท่านั้น ; เงื่อนไข: เทียบฟังก์ชัน GAS ตรงตัวอักษรจดใน tasks.md, audit actor จาก token + batch เดียวกับเอกสาร, /api/audit-logs เฉพาะ admin, ลายเซ็นแก้ได้เฉพาะ admin/เจ้าของ + จำกัดขนาด/ชนิด, ผู้รับแจ้งเตือนตรง GAS ห้ามข้ามแผนก + mark-read กัน IDOR + helper เดียว, migration ไม่มี DROP, smoke รอบ 2 เป็นเอกสารใหม่, เจอเรื่องเปลี่ยน UX/business rule ให้หยุด ask

- [2026-10-13] M6 ปิดครบ (ผ่าน QA+kla, npm test 1968/1968): E PO มี alias prNo จาก prNumber ; e2e/cf/seed.mjs กัน --remote

- [2026-10-13] C/D ปิด (ผ่าน QA+kla): โหมด CF ตัวเลขงบ (กล่อง PR, Dashboard, ธงเกินงบ, BudgetContext) ใช้ budgetService.calculatePeriodBudgetSummary แบบ BudgetView (workflowEngine เดิมจำลองยอด 65-95% — mock/GAS คงเดิม) ; server เขียน audit_logs ตอนเปลี่ยนสถานะ PR (actor จาก token, batch เดียวกับ PR) และประกอบ timeline ตอนอ่านแบบ GAS ; client ส่ง entry AL-/AUD- กลับถูกทิ้ง

- [2026-10-13] H = พฤติกรรมเดิม (ONLINE_PURCHASER ดูงบแบบภาพรวมโดยเจตนา) ไม่แก้ ; I/J แก้แล้ว ผ่าน QA+kla

- [2026-10-13] A/B ปิด (ผ่าน QA+kla): โหมด CF โหลด bootstrap ทันทีหลัง login ไม่ seed ข้อมูลตัวอย่าง ไม่เรียก /api/storage ; แคช localStorage ผูกเจ้าของ (session.userId) + ทิ้ง response ที่ token เปลี่ยน ; logout ล้างแคชทั้งหมด ; logout ไม่ revoke token ฝั่ง server คงเดิม (ยอมรับแล้ว)

- [2026-10-13] ผู้ใช้สั่งแก้บั๊ก smoke test ลำดับ G > F > A > B ก่อน

- [2026-10-13] G/F ปิดแล้ว (ผ่าน QA+kla ; ผู้ใช้สั่งแก้เพิ่มระหว่างทาง): server เป็นเจ้าของการบวกสต็อกตอนรับของ (MAC ตาม GAS, กันซ้ำด้วยเลข GRN, เพดานต่อบรรทัด + ต่อ PR หน่วยฐาน) ; ล็อกบรรทัด PO/อัตราแปลงหลังสั่งซื้อ ; PR หลังอนุมัติแก้จำนวนไม่ได้ ; สร้าง PO เฉพาะผู้อนุมัติขั้นสุดท้าย/admin ; สถานะ PO normalize + allowlist ; รายละเอียด docs/parity.md

- [2026-10-13] M5 R2 storage adapter เสร็จ ผ่าน QA+kla (Fable cmv6ddh435d434): ไฟล์ใหม่เก็บ R2 (FILE_STORAGE=r2 ค่าเริ่มต้น) อ่านตามแถว attachments.storage, โค้ด Drive คงไว้ ; migration 0013 ; scripts/migrate-files.js dry-run เท่านั้น ; runbook ขั้น 1 เป็น R2 ; ก่อน deploy apply migrations ถึง 0013

- [2026-10-13] ผู้ใช้สั่ง + Fable อนุมัติ (cmv6ddh435d434): ไฟล์แนบเก็บ R2 ก่อน (binding FILES, Gmail ส่วนตัวสร้าง Shared Drive ไม่ได้) คงโค้ด Drive ไว้ย้ายภายหลัง ; สเปก docs/requirements-file-storage.md ; แบ่งส่ง 2 ช่วง (A adapter+0013+endpoint / B config+e2e+migrate dry-run+เอกสาร) ; ทีมห้ามรัน wrangler r2 / d1 --remote / deploy

- [2026-10-13] **ที่เก็บไฟล์: ใช้ Cloudflare R2 ตอนนี้ และเขียนโค้ดให้สลับไป Google Shared Drive ได้ภายหลัง** (ผู้ใช้ตัดสิน — บัญชีเป็น Gmail สร้าง Shared Drive ไม่ได้ SA จึงใช้ไม่ได้) ; requirement เต็ม `docs/requirements-file-storage.md` (storage adapter r2/drive สลับด้วย FILE_STORAGE, attachments.storage/objectKey migration 0013, คง drive.js, แผนย้าย R2→Drive + rollback) ; เป็นการเปลี่ยนสถาปัตยกรรม Neo ต้อง consult Fable ก่อน และ kla ตรวจหลัง QA ; ยกเลิกรายการ "Service Account + Shared Drive" ใน M2 (ย้ายไปทำเมื่อมี Workspace)

- [2026-10-13] D-2 ปิด: bootstrap/GET products ส่ง alias price/stockBalance/reorderPoint/unit/avgCost ; ขาเข้าชื่อ UI ชนะชื่อ D1 ; fail-safe avgCost จับด้วย id/code (ไม่จับชื่อแบบ GAS)
- [2026-10-13] ผู้ใช้เลือก (ask): ทีมเตรียมคำสั่ง M2 ให้ก๊อปรันเอง → docs/M2_RUNBOOK.md (PowerShell 5.1, ผ่าน QA+kla) + scripts/set-user-password.js ตั้งรหัสแอดมินคนแรก (ขั้น 5.5) ; ทีมไม่รันคำสั่งที่แตะ remote
- [2026-10-13] Fable อนุมัติปิดเฟส 2 (cmv5g7gm24abda): stock log ตรวจแผนก, บังคับเปลี่ยนรหัส+tokenVersion, server กรองข้อมูล=หน้าจอเดิม+ฟิลด์หลักฐานประทับ token, proxy ไฟล์ /api/files/:id, CSP, PDF ใช้ pdf-lib ในโปรเจกต์ ; ก่อน deploy: apply migrations 0001-0012 + backfill file_refs ; รายละเอียด docs/parity.md
- [2026-10-13] ผู้ใช้เลือก (ask) ทำตามที่แนะนำ: ปิด anyone-with-link ไฟล์ใหม่ + ถอดสิทธิ์ไฟล์เก่าหลัง cutover ; ปิด job GitHub Pages ; ผู้ใช้ระดับ 2+ แก้งบทุกแผนกคงเดิม ; บังคับเลือกบทบาทตอนสร้างผู้ใช้
- [2026-10-13] ผู้ใช้เลือก: เพิ่มหน้าต่างเปลี่ยนรหัสเล็ก ๆ สไตล์เดิม (โหมด CF) เด้งเมื่อบัญชีต้องเปลี่ยนรหัส + เปิดจากเมนูโปรไฟล์ ; กรองข้อมูลที่ server = เท่ากับที่หน้าจอเดิมของผู้ใช้เห็นได้จริง (รวมทุกหน้า) ผู้ใช้ไม่เห็นอะไรเปลี่ยน ; users/products/departments ส่งครบซ่อนฟิลด์ลับ ; สิทธิ์ดูทุกแผนกคงเดิม
- [2026-10-13] logout เป็น stateless (token หมดอายุ 8 ชม.) — ยอมรับ ; ปิดบัญชี/เปลี่ยนรหัส → tokenVersion+1
- [2026-10-13] ผู้ใช้เลือก: หน้า Online (OnlineTaskView/OnlineProcurementHub) เปิดที่เดือนปัจจุบัน ; ไม่ต้องทำ Login with Google บน GAS — ใช้ login ด้วยรหัสที่สร้างใหม่
- [2026-10-13] Fable อนุมัติเปิดเฟส 2 (cmv4qxjf733ddc) ขอบเขต Cloudflare เท่านั้น ; ผู้ใช้ตัดสิน: migrations ชุดเดียวที่ root (ลบสำเนา cloudflare/migrations) ; บังคับเปลี่ยนรหัสเฉพาะบัญชีที่แอดมินสร้าง/รีเซ็ต ; ยกเลิก token เมื่อเปลี่ยนรหัสเองและแอดมินรีเซ็ต ; migration ใหม่ 0010+ ไม่มี DROP
- [2026-10-13] ผู้ใช้เลือก (ask amv4na2y98): ช่องโหว่กลาง/ต่ำที่เหลือ แก้ในเฟส 2 ตามลำดับ: ตัด GAS (ผู้ใช้) > stock log ตรวจแผนก > บังคับเปลี่ยนรหัส/ยกเลิก token > กรองข้อมูลที่ server > proxy ไฟล์ — แผน docs/plan.md
- [2026-10-13] Fable อนุมัติปิดเฟส 1 (cmv4n8ly427e60) ; เฟสถัดไปต้อง consult ใหม่ ; migrations source of truth = migrations/ ที่ root (cloudflare/migrations เป็นสำเนา มีเทสต์เทียบ)
- [2026-10-13] ผู้ใช้เลือก: เก็บไฟล์ใน Shared Drive (โฟลเดอร์ 1sWzuoHrxiKUmZLY4e-czp2y2z8qcyHjN ; ผู้ใช้ตั้ง SA เป็น Content manager เอง) ; หน้างบเปิดที่เดือนปัจจุบัน
- [2026-10-13] ผู้ใช้เลือก: คืน/เติมงบของผู้ไม่มีสิทธิ์งบ (L1/online) ต้องอ้างเลข PO, คืนได้ครั้งเดียวต่อ PO, ไม่เกินยอดที่ PO ตัดงบจริง ; ผู้ดูแลระบบ = level 99 หรือ roleId ADMIN ตรงตัวเท่านั้น
- [2026-10-13] ปิดยอด PO: server คำนวณส่วนต่างเอง, สถานะตาม GAS (settlementStatus), แก้ยอดซ้ำได้แต่คืนงบครั้งแรกเท่านั้น
- [2026-10-13] ผู้ใช้อนุมัติ: ตัดทางลัด bootstrap admin + รหัส default ใน gas/ (ยังไม่ clasp push) ; GitHub Pages deploy เฉพาะ workflow_dispatch
- [2026-10-12] M4 ผ่าน QA+kla: ไฟล์ใหม่ไม่แชร์สาธารณะ เปิดผ่าน proxy ทุกจุด (Word/Excel โหมด CF เป็นปุ่มเปิดไฟล์) ; admin POST /api/admin/unshare-public (dry-run เริ่มต้น) รันหลัง cutover ; ปิด job GitHub Pages (เหลือ test) ; บังคับเลือกบทบาทตอนสร้าง/แก้ผู้ใช้ (server 400 ถ้าไม่มี)
- [2026-10-12] ผู้ใช้เลือก: D1 เป็นข้อมูลหลัก ; GAS เดิมให้บริการต่อจนตัดระบบ ; Drive ใช้ Service Account โฟลเดอร์รากใหม่ ; ไฟล์แนบ anyone-with-link ; cloudflare/src + backend-gas archive ภายหลัง
- [2026-10-12] ผู้ใช้เลือก: ติดตั้ง wrangler devDependency ; ตัดรหัส default (123456/password123/admin123) ใน Cloudflare (แอดมินตั้งรหัสให้ผู้ใช้ใหม่เอง) ; login ได้เฉพาะ status ACTIVE (ตรง GAS)
- [2026-10-12] Auth: token = base64url(payload).HMAC อายุ 8 ชม. secret AUTH_TOKEN_SECRET ≥32 ตัว (wrangler secret) ; login ผิด 5 ครั้ง/user ล็อก 15 นาที, เพดาน 30 ครั้ง/IP ; INACTIVE ได้ 403 ข้อความเฉพาะ (ตาม GAS) ; ต้อง apply migrations 0002/0003 ก่อนใช้ login
- [2026-10-12] Parity: เลข PR รูปแบบเดิมแต่ใช้ปีปัจจุบัน ; สถานะ PR/PO ยึดค่าที่ GAS บันทึก ; canDeleteMaster ยึดพฤติกรรมจริง (level≥1 ลบได้) ; PR ใหม่ห้ามแผนก ALL/BOTH ยกเว้น admin ; ตาราง parity = docs/parity.md
- [2026-10-12] RBAC ฝั่ง server ยึดตาราง docs/parity.md c.5 (functions/_lib/rbac.js) ; สิทธิ์แผนกฝั่ง server = src/utils/permissions.js ; ledger/stock log append-only
- [2026-10-12] CORS: ALLOWED_ORIGINS allowlist (ไม่ตั้ง = same-origin)
- [2026-10-12] deploy จาก root เท่านั้น: npm run build:cf + wrangler pages ; cloudflare/functions ซิงก์ด้วย node scripts/prepare-cloudflare.js --backend-only ; คู่มือ docs/DEPLOY_CLOUDFLARE.md ; Node 22
- [2026-10-12] prae-qa ไม่มี shell บนเครื่องนี้ → QA อ่านโค้ด ; คำสั่งรันโดยโค้ดเดอร์/Neo ; `npm test` ขอบเขต tests + src/services/__tests__
- [2026-10-11] ผู้ใช้มอบอำนาจทีมทำงานอัตโนมัติจนเสร็จ (ระบบใช้งานภายใน) — รายละเอียดหัวข้อ "โหมดอัตโนมัติ" ใน CLAUDE.md ; ยังต้อง ask เฉพาะ: ลบไฟล์ของผู้ใช้, แก้ `data/`, git push, deploy (clasp/wrangler), เปลี่ยน UX/UI หรือ business rule

- [2026-10-13] M2: ผู้ใช้สั่งลบ D1 เดิม (ข้อมูล seed 72 แถว backup ไว้ที่ C:\Users\Admin\prpo-backups\prpo-db-20261013.sql) แล้วสร้างใหม่ ; D1 `prpo-db` id ใหม่ `c64022bb-88eb-485f-94f7-dd9e9617e44c` ; D1 `prpo-db-preview` id `00791d04-880f-4106-a2fc-f3349bcb013f` ; Pages project `prpo-pdqc` สร้างแล้ว (production branch main) ; migrations 0001-0012 apply ทั้งสองฐานแล้ว ; Preview deploy แล้ว https://preview.prpo-pdqc.pages.dev (หน้าโหลด 200 + CSP/XFO/nosniff ครบ, AUTH_TOKEN_SECRET ตั้งแล้วทั้ง production/preview (สุ่ม 48 ไบต์ คนละค่า) → /api/health 401 ; ฐาน preview มี mock: แผนก PD/QC/PUR/MGT, users admin.test(ADMIN 99)/plant.test/asst.test/online.test/req.test ยังไม่มีรหัส ผู้ใช้ตั้งเองผ่าน set-user-password.js ; ที่เก็บไฟล์ยังไม่ตัดสิน (Shared Drive ใช้ไม่ได้ เป็น Gmail — เสนอ R2) ; GOOGLE_SA_* ยังไม่ตั้ง) ; อัปเดต id ใน wrangler.toml ทั้งสอง, e2e/cf/seed.mjs, playwright.cf.config.js, scripts/prepare-cloudflare.js, cloudflare/README.md
- [2026-10-11] Cloudflare ของผู้ใช้: Account ID `bf8a6b6235d3b15616d8558762099275` ; D1 Studio: https://dash.cloudflare.com/bf8a6b6235d3b15616d8558762099275/workers/d1 (เลือก prpo-db)
- [2026-10-11] git remote origin = https://github.com/EngineeringDepSethachon/PRPO.git (ผู้ใช้ push เอง ทีมห้าม push)

## ⛔ ห้ามทำ

- ห้าม push ขึ้น git / ลบไฟล์ / ติดตั้งแพ็กเกจใหม่ โดยไม่ถามผู้ใช้ก่อน
- ห้าม commit key Service Account หรือ secret ใด ๆ ; ห้ามรัน d1 --remote

## ⏳ ค้างอยู่

- **[2026-10-15] จำกัดการปิด PO ที่ค้างเคลม — Claude ทำครบ 3 ชั้นแล้ว (server rbac+route poOwnerCtx, client PODetailsModal.canResolveSelfClaim, เทสต์ 5 ไฟล์ + parity.md c.5) ตามคำสั่งผู้ใช้ "คุณทำเลย"** ; **ข้อสังเกตให้ kla/ทีมตรวจต่อ:** client เก็บ `requesterId` เป็น roleId (เช่น REQUESTER_PD) ไม่ใช่ user id → server จับ "เจ้าของ" ได้จาก `requesterName` ตรงกับชื่อใน token เป็นหลัก (ชื่อซ้ำกัน = ถือเป็นเจ้าของทั้งคู่) ควรให้ PR เก็บ user id จริงใน requesterId (งาน follow-up) ; สเปกเดิมที่เขียนไว้: (1) server `rbac.js canTransitionPO(authUser, from, to, ctx)` เพิ่ม ctx `{isOwner, isOnlinePo}` ; กฎ: from ∈ {CLAIM_REPORTED, CLAIM_IN_PROGRESS, CLAIM_PENDING, PARTIALLY_RECEIVED_IN_CLAIM, WAITING_DELIVERY_ROUND_2} → to ∈ {CLOSED, COMPLETED, COMPLETED_WITH_REFUND, SETTLED} อนุญาตเฉพาะ admin, level>=3 (ไม่ใช่ online), online purchaser (เคลมออนไลน์), หรือ isOwner (prs.requesterId == authUser.userId หรือ requesterName == authUser.name ; route หา owner จาก pos.prId/prNumber → prs) ; **ห้ามแตะ ORDERED→CLOSED/COMPLETED** (settle/รับครบปกติ) (2) client `PODetailsModal` ซ่อนปุ่มปิดเคลม/จัดการเคสจาก Reviewer/ผู้รับที่ไม่ใช่เจ้าของ (ตอนนี้ To-Do เป็น Requester+Admin แล้วแต่ปุ่มยังเปิดให้ L2) (3) อัปเดตเทสต์ที่บันทึกกฎเดิม "requester/receiver/reviewer ปิดเคลมได้": tests/cf_p4_claims_guards (R3-1/2, R4-4, R4-6, R5-2, R5-4), cf_qa_r5_po_transitions (10 เคส WAITING_DELIVERY_ROUND_2/PARTIALLY_RECEIVED_IN_CLAIM/CLAIM_REPORTED → COMPLETED* as L1/L2), cf_rbac PO_TABLE แถว CLAIM_*→COMPLETED (ALLP → ONLINE/L3/L4/ADMIN + owner ctx), cf_s4_pr_cascade S4d (ผู้เรียกต้องเป็นเจ้าของ PR หรือใช้ admin) ; parity.md c.5 อัปเดตด้วย
- **[2026-10-14 ค่ำ] TC-001 ทำแล้ว deploy แล้ว** (commit ถัดจาก eeb0902): PDF PO ช่องผู้ขอซื้อใช้ผู้ขอซื้อตัวจริงของ PR (id → ชื่อตรงตัว) ไม่ fallback role/users[0] ; ไม่มีลายเซ็น = ช่องว่าง ; QA ควรเทสต์ PDF กับ PR ที่ผู้ขอซื้อมี/ไม่มีลายเซ็น

- **รอผู้ใช้ตัดสิน (M9):** TC-001 ลายเซ็น 'ผู้ขอซื้อ' ใน PDF PO เลือกตาม role (users[0]=admin) — ใช้ลายเซ็นผู้ขอซื้อตัวจริงหรือคงตาม role ; kla กลาง: ผู้ใช้ทั่วไปในแผนกเปลี่ยน PO ที่ค้างเคลมเป็น COMPLETED/CLOSED ได้โดยไม่มี canCloseClaim (rbac.js:383 canTransitionPO ปล่อยผ่าน) — เรื่องเดียวกับ short-close S4 ที่รอตัดสิน
- ต่ำ M9 (บันทึก): footer/หัวโมดัล error สร้างสินค้า 'รหัสสินค้านี้ถูกใช้งานแล้ว' ไม่ตรงสาเหตุ 400 ยอดตั้งต้น ; modal skipped ของ batch บอก 'รายการของแผนกอื่น' ไม่ตรงสาเหตุ ; POST/PUT เดี่ยวแบบ array เขียนบางส่วนก่อน 400 (client ไม่ส่ง array) ; ลบสินค้าแล้วสร้างรหัสเดิมได้ยอดเก่า (server เป็นเจ้าของยอด) ; receiveToStock/submitGRN ไม่มี UI เรียก ถ้าใช้ในโหมด CF ยอดไม่บวก ; PO เก่าที่ flag เคลมค้างใน D1 ล้างเมื่อ resolve ครั้งถัดไป
- **[2026-10-14 บ่าย-เย็น] Claude แก้+deploy ตรงบน production 4 เรื่องจากคนเทส (commit 09b6eb9, 099d557, 9e106e2, a25472d, d212665 — ผู้ใช้ push ด้วย `git push origin uat:main`)**: สร้างแผนกส่ง PUT แทน POST ไม่บันทึก ; แก้รหัสย่อแผนกไม่อัปเดต (server UPDATE ไม่มีคอลัมน์ code) ; ป้าย/ลิงก์ "เปิดดูใน Google Drive" สำหรับไฟล์ R2 ; ไฟล์แนบรวมชื่อซ้ำรูปสินค้าถูกซ่อน (dedupe ด้วย fileId แทนชื่อ) ; รูปสเปกใน lightbox ยิง /api/files ตรงไม่มี token (ส่ง fileId ให้ lightbox + รู้จัก proxy path) ; **ทีมควรเพิ่มเทสต์ครอบทั้ง 5 เคส**

- **[2026-10-14 บ่าย] Claude deploy แก้บั๊ก S1-S8 ขึ้นจริงแล้ว (ผู้ใช้สั่ง "เอาขึ้นเลย")**: migrations 0015-0016 apply prod+preview ; npm test 2109/2109 ; deploy Production cd9b5482 + Preview 925516c9 ; /api/health 401 ทั้งคู่ ; commit `f2abd9a` (รวม docs/ADMIN_SETUP_GUIDE.md, reset-admin-password.bat, docs/smoke-test-2026-10-14.md) **ผู้ใช้ต้อง push เอง** ; **แก้แล้ว 2026-10-14 บ่าย: สร้างแผนกไม่บันทึก** สาเหตุ apiService.saveDepartment ตัดสิน isUpdate จาก payload.id ซึ่งฟอร์มสร้างใหม่ใส่ `DEPT-<code>` ล่วงหน้า → ส่ง PUT แทน POST → server UPDATE แถวที่ไม่มี ตอบ 200 → หน้าจอว่าสำเร็จแต่ไม่มีแถว (ผู้ใช้จึงสร้างต่อไม่ได้เพราะไม่มีแผนกให้เลือก) ; แก้ให้เช็คว่ามีแผนกนั้นอยู่แล้วจริงก่อนใช้ PUT ; ทดสอบ local ผ่าน (POST + แถวขึ้น) ; deploy แล้ว ; commit ต่อจาก f2abd9a (ผู้ใช้ push ด้วย `git push origin uat:main`) ; **ทีมควรเพิ่มเทสต์ + พิจารณาให้ server PUT /api/departments upsert ด้วย** ; บั๊กนี้มีในโค้ดเดิมก่อนย้าย (ตรรกะ isUpdate เดิม) แต่โหมด mock ไม่สังเกตเพราะ localStorage เก็บให้

- ผู้ใช้ต้องลบเอง (สำคัญ ก่อน apply migrations): C:\Users\Admin\Desktop\PRPO\migrations\0016_stock_logs_grn_backfill.sql — ทีมยกเลิกแล้ว (เคยเป็น UPDATE ข้อมูลเดิม) ตอนนี้ Neo เขียนทับเป็น SELECT 1 ; ลบได้เลย
- **รอผู้ใช้ตัดสิน (kla กลาง S4):** ผู้ขอซื้อ/ผู้ตรวจในแผนกเปลี่ยน PO เป็น CLOSED ผ่าน PUT ได้โดยไม่รับของจริง (short-close เดิม ตรง GAS ไม่มี RBAC) และตอนนี้ปิด PR ตามไปด้วย — ถ้าจะจำกัดให้เฉพาะผู้รับของ/ผู้ซื้อออนไลน์/admin หรือบังคับเหตุผล = เปลี่ยน business rule ; ตอนนี้เพิ่ม audit PR_COMPLETED_BY_PO ไว้ตามย้อน
- ต่ำ S5 (บันทึก): PUT notifications/read-all ไม่มี rate limit ; key อ่านแล้วใน localStorage ใช้ชื่อผู้ใช้ ; โหมด GAS/mock สถานะอ่านค้างหลัง logout (เดิม) ; PO list COMPLETED_WITH_REFUND ยังแสดงรหัสดิบ (เทสต์เดิมล็อกไว้)

- **[2026-10-14] M2 ทำแล้วโดย Claude ตามคำสั่งผู้ใช้:** migrations 0013-0014 apply แล้วทั้ง prod/preview (backup C:\Users\Admin\prpo-backups\prpo-db-20261014-pre0013.sql) ; ไม่ย้ายข้อมูล Sheets (ผู้ใช้ยืนยันไม่มีข้อมูลที่ต้องย้าย) ; deploy Preview + Production แล้ว (https://prpo-pdqc.pages.dev /api/health 401, CSP/XFO/nosniff ครบ) ; สร้างแอดมิน production `admin` (ADMIN/99) ผู้ใช้ตั้งรหัสเองผ่าน set-user-password.js (mustChangePassword=1) ; commit 903ee19 แล้วแต่ **push ถูกปฏิเสธสิทธิ์ ผู้ใช้ต้อง push เอง** ; ไฟล์ temp 4 ตัวใน docs ไม่มีแล้ว แต่ **tests/_dbg_sig.test.js และ vt_tmp_out.json ลบไม่ได้ (permission) ผู้ใช้ลบเอง** ; **ยังไม่ตัด GAS** (ต้องทำใน script.google.com ด้วยบัญชี Google ของผู้ใช้)
- **[2026-10-14] smoke test รอบ 3 ทุกบทบาทบน localhost → `docs/smoke-test-2026-10-14.md` + รูป `docs/smoke-screenshots-2026-10-14/`** บั๊กต้องแก้ก่อนใช้จริง: **S1 สูง** ปรับปรุงยอดสต็อก/รับเข้าคลัง (Manual) ในโหมด CF ไม่บันทึกและไม่แจ้ง error (StockAdjustmentModal/ManualStockInModal เขียน storageService อย่างเดียว) ; **S2 สูง** แอดมินกดจัดสรรงบไม่ได้ (bootstrap ตั้ง canOnlinePurchase=true ให้ admin → BudgetView:126 ตัดสิทธิ์) ; **S3 กลาง** รับของรอบ 2 ครบแล้ว PO ยังค้าง PARTIALLY_RECEIVED_IN_CLAIM + ป้ายสถานะดิบ (WAITING_DELIVERY_ROUND_2, PARTIALLY_RECEIVED_IN_CLAIM, REJECTED_TO_DRAFT) ; **S4 กลาง** PR ออนไลน์ค้าง "รอสั่ง Online" หลัง PO รับครบ ; **S5 กลาง** ไม่มีกระดิ่งแจ้งเตือนใน UI (server สร้าง 16 แถว แต่ Sidebar ไม่ render) ; **S6 กลาง** รูปสินค้าต่อรายการ + เอกสารประกอบรวมเก็บ base64 ใน PR ไม่ขึ้น R2 (ใบเสนอราคา/GRN ขึ้น R2 ถูก) ; **S7 กลาง** ฟอร์ม PR ไม่ล้างหลังส่ง (โชว์เลขใหม่พร้อมข้อมูลเดิม) ; S8 ไม่มี audit GOODS_RECEIVED/IN_NG และ stock_logs.grnNumber ว่าง ; S9 ปุ่ม "ล้างประวัติธุรกรรมจำลอง" ยังโชว์ใน Audit Log ; S10 สร้างสินค้า/ผู้ขายยิง save 2 ครั้ง (uncaught duplicate) ; ต่ำ: login บอก 24 ชม. (จริง 8), รันรหัสสินค้าอัตโนมัติได้ "1", PR ส่งกลับยังนับผูกพันในกล่องงบ, bootstrap ซ้ำ 3 ครั้ง/การกระทำ

- **งานใหม่ (Neo): ทำ R2 storage adapter ตาม docs/requirements-file-storage.md** (consult Fable → สมชายแตก task → malee → QA → kla) ; **R2 เปิดแล้ว + bucket `prpo-files` / `prpo-files-preview` สร้างแล้ว (2026-10-13) + binding `FILES` และ `FILE_STORAGE="r2"` ใส่ใน wrangler.toml แล้ว** ทีมเริ่มเขียนโค้ดได้ทันที (อย่าสร้าง bucket/binding ซ้ำ)
- D-2 แก้แล้ว deploy Preview รอบใหม่แล้ว (2026-10-13, deployment 5575d3c8) — รอผู้ใช้ยืนยันหน้า Master Data/Dashboard

- ผู้ใช้ต้องทำเองก่อนขึ้นจริง: ทำตาม docs/M2_RUNBOOK.md ขั้น 0-8 (ขั้น 4.0 หยุดใช้ GAS ก่อน export ; ตัดสินตอนรัน: --force-change-password, ล้าง password/pin ในชีตหลังพ้น rollback)
- ก่อน cutover: แอดมินในชีตเดิมต้องมี roleId ADMIN หรือ level 99
- ความเสี่ยงที่ยอมรับ + เงื่อนไขปิด: (1) anyone-with-link → "ไฟล์ใหม่ private แล้ว ; หลัง cutover admin รัน unshare-public (dry-run ก่อน) เพื่อถอดสิทธิ์ไฟล์เก่า" ; (2) GAS เชื่อ userContext จาก client — ต้องปิด web app GAS หรือ clasp push ตัวแก้ทันทีหลังตัดระบบ ห้ามปล่อยค้าง
- ต่ำ (บันทึก): online settle ฝั่ง D1 ไม่คืนงบจาก actualTotalAmount (client คืนเองผ่าน ledger) ; parity: ไม่บังคับแผนก/เจ้าของเอกสารฝั่ง server, แก้ items PR ได้ทุกสถานะ
- ถามผู้ใช้อีกครั้งตอนตัดระบบ: ล้างรหัส plaintext ใน Sheets
- ต่ำ (รอผู้ใช้ตัดสินภายหลัง): จับคู่ code ที่มีช่องว่าง/อักษรไม่ใช่ ASCII ระหว่าง stock-logs กับ MAC ; ฟอนต์ PDF ของ GAS โหลดจาก jsdelivr ; หน้า login ส่ง IP ไป api.ipify.org ; ตัวเลขยอดคืนที่แสดงผล client เขียนได้ภายใต้เพดาน (ไม่กระทบ ledger) ; เปิดไฟล์ private ที่ไม่มีสิทธิ์/เน็ตล่มจะไปหน้าขอสิทธิ์ Google (proxy ตอบ 404 เหมือนกันกันเดา)
- ผู้ใช้ต้องลบไฟล์ temp เอง (permission บล็อกทีม): C:\Users\Admin\Desktop\PRPO\docs\_tmp_assemble.cjs, C:\Users\Admin\Desktop\PRPO\docs\_tmp_step1_head.md, C:\Users\Admin\Desktop\PRPO\docs\_tmp_step1_tail.md, C:\Users\Admin\Desktop\PRPO\docs\_tmp_later_head.md, C:\Users\Admin\Desktop\PRPO\tests\_dbg_sig.test.js (ไฟล์ it.skip เปล่าของ M7-4b), C:\Users\Admin\Desktop\PRPO\test-results\s1_live.mjs, C:\Users\Admin\Desktop\PRPO\test-results\s1_live2_sqlcheck.mjs, C:\Users\Admin\Desktop\PRPO\test-results\s4-local-check.mjs, C:\Users\Admin\Desktop\PRPO\test-results\s4-local.sql, C:\Users\Admin\Desktop\PRPO\test-results\s4-q.sql, C:\Users\Admin\Desktop\PRPO\test-results\s4-audit-check.mjs, C:\Users\Admin\Desktop\PRPO\test-results\s4-forge-check.mjs, C:\Users\Admin\Desktop\PRPO\test-results\s4-audit.sql, C:\Users\Admin\Desktop\PRPO\test-results\s7_tmp.json
- ถามผู้ใช้ภายหลัง: lifecycle ลบถาวร trash/ ใน R2 เกิน 30 วัน (ตอนนี้ไม่ลบอัตโนมัติ) ; id โฟลเดอร์ Drive ยืนยันตอนย้ายไป Google Drive
- ลบ/แก้บรรทัดที่อ้าง Service Account/Shared Drive เป็นขั้นก่อนขึ้นจริง (ตอนนี้เป็นงานภายหลังเมื่อมี Google Workspace)
- ต่ำ (บันทึก): PR อนุมัติ/ส่งกลับพร้อมกัน 2 request ผ่านทั้งคู่ (ไม่มี optimistic lock) ; PRDetailsModal self-heal สถานะจาก activityLog (เดิม, แสดงผลเท่านั้น) ; แผนกไม่มีงบเดือนนี้ → ธงเกินงบขึ้น (zero-based ตรง BudgetView)
- ต่ำ (บันทึก): admin แยกแถว audit ที่ client ส่งไม่ได้ (ต้องเพิ่มป้าย = เปลี่ยน UI ถามผู้ใช้ภายหลัง)
- ต่ำ (บันทึก): ลายเซ็นตาม role ใช้ภาพเดียวกันทุกคนใน role นั้น (ตาม GAS)
- ต่ำ (บันทึก): ลายเซ็นทุกคนอ่านได้ทาง GET /api/users ทุกคนที่ login (ตามระบบเดิม)
- ต่ำ (ตรวจใน smoke รอบ 2): หน้า Audit Log รีโหลด 2000 แถวทุกครั้งที่มี log ในเครื่อง ; ORDER BY julianday ไม่ใช้ index
- ต่ำ (บันทึก) M7-2: lock ใช้ status อย่างเดียว — แก้เนื้อหาพร้อมกันในสถานะเดิม/ABA ยังทับได้ ; POST หลาย PR ได้ 409 บางส่วน ; PUT ไม่พบแถวตอบ success ; ดับเบิลคลิกสร้าง PR → 409 modal (ข้อมูลไม่เสีย) ; Approver role ที่ canViewAllDepts=0 ยังได้แจ้งเตือนแผนกอื่น (ตรง GAS) ; เหตุผลยกเลิก PR แจ้งทั้งแผนก (ตรง GAS)
- ผู้ใช้เลือก (ask 2026-10-13): ไม่แจ้งเตือน Approver ตอนส่งจากร่าง/ส่งใหม่ (ตรง GAS) ; ไม่เพิ่มป้ายแถว audit จาก client
- ต่ำ M8 (บันทึก): /api/stock/issue ยังรับ unitCost/docNo จาก client (มูลค่าใน log ปลอมได้ ยอดไม่กระทบ) ; ปรับลดจนเหลือ 0 จากยอดมีเศษอาจเก็บ -0.0
- ต่ำ (บันทึก) M8: hasBudgetAccess ยังใช้ canAccess หลวม (เข้าดูหน้าได้ ข้อมูล server กรอง) ; adminRule fallback user.id ; /allocate กลืน error DB ตอบ success ; สินค้ากองกลาง ALL ปรับยอดได้ทุกแผนก (business rule) ; stock_logs.actorId = roleKey (ตาม /stock/issue)
- ต่ำ (บันทึก): หลัง smoke r2: แท็บ 'ปิดงานแล้ว' ในรายการ PO ไม่นับ COMPLETED (พฤติกรรมเดิม — เปลี่ยน = ถามผู้ใช้) ; PR ค้าง 'รอสั่ง Online' หลังเคลม/ยกเลิก PO (เดิม) ; รหัสแผนกจริงที่ขึ้นต้น 'ฝ่าย' จะถูกตัด — เช็กตอนย้ายข้อมูล Sheets ; writer ติดป้าย CLAIM_CREDIT ไม่มี docNo ให้ PO อื่นในแผนกได้ ; writer เขียน ledger แผนก ALL ได้ (เดิม) ; ORDER BY createdAt ที่รูปแบบปน
- ต่ำ S6 (บันทึก): ไฟล์กำพร้าใน R2 ล้างเฉพาะเมื่อ admin สั่ง (เสนอ Cron Trigger) ; server ยังรับ data: URL ≤400k (บังคับหลัง deploy client ใหม่)
- ต่ำ S8 (บันทึก): IN_NG สะสมต่อ PO ไม่มีเพดานรวม (ต่อคำขอจำกัด) ; GRN ใน grnHistory มาจาก client (รูปแบบไม่คงที่) ; poReceiveNotificationParams ยัง fallback 'ALL' ถ้าเส้นทางอื่นเรียก ; ตารางสต็อกแสดงแถว IN_NG เป็น +N สีเขียว (มีป้าย IN (NG))
- ต่ำ M9 (บันทึก): gate แผนกกับ handler PUT/POST products (ยังไม่พบว่าโจมตีได้) ; csvCell ไม่ตรวจช่องว่างนำหน้า =
- ผู้ใช้ลบเอง: C:\Users\Admin\Desktop\PRPO\.vt_malee.json, โฟลเดอร์ C:\Users\Admin\Desktop\PRPO\cloudflare\src\ และ C:\Users\Admin\Desktop\PRPO\cloudflare\public\_headers (สคริปต์ prepare สร้างเกิน)
- ผู้ใช้รันเอง: git checkout -- cloudflare/.env.example cloudflare/index.html cloudflare/jsconfig.json cloudflare/tailwind.config.js cloudflare/vite.config.js cloudflare/wrangler.toml cloudflare/wrangler.toml.example (อนุมัติแล้ว แต่สิทธิ์เครื่องบล็อกทีม)

## 🎯 Milestones

### M9: แก้บั๊กผู้ทดสอบ 2026-10-14 (docs/bug-log-tester-2026-10-14.md)

- [x] TC-008 เบิกจ่ายด่วนตัดต้นทุนที่ราคาตั้งต้นแทน MAC
- [x] TC-007 สถิติ/ประวัติเบิกจ่ายด่วนไม่มีข้อมูล
- [x] TC-004 หมายเหตุสินค้าไม่บันทึก
- [x] TC-003/006/009 สายเคลมค้างกลางทาง
- [x] TC-005 กระดิ่งมี badge แต่รายการว่าง
- [x] TC-002 รูป GRN เปิดเต็มไม่ได้
- [x] /api/products/batch เขียนยอดสต็อกจาก cache client ทับยอดจริง (QA กลาง, ของเดิม)

### M8: แก้บั๊ก smoke test 2026-10-14 (docs/smoke-test-2026-10-14.md)

- [x] S1 สูง: ปรับยอดสต็อก/รับเข้า Manual ไม่บันทึกในโหมด CF
- [x] S2 สูง: แอดมินจัดสรรงบไม่ได้
- [x] S3 กลาง: PO รับรอบ 2 ครบแต่ค้าง PARTIALLY_RECEIVED_IN_CLAIM + ป้ายสถานะดิบ
- [x] S4 กลาง: PR ออนไลน์ไม่ cascade เป็น completed หลัง PO รับครบ
- [x] S5 กลาง: ไม่มี UI แจ้งเตือน (กระดิ่ง)
- [x] S6 กลาง: รูปสินค้า/รูปประกอบรวมขึ้น R2 แทน base64
- [x] S7 กลาง: ฟอร์ม PR ล้างหลังส่งสำเร็จ (กด "ตกลง")
- [x] S8 ต่ำ-กลาง: stock log รับของ (grnNumber + IN_NG) + audit/แจ้งเตือนรับบางส่วน

### M2: เตรียมขึ้นระบบจริง (ผู้ใช้ทำตาม checklist ใน docs/DEPLOY_CLOUDFLARE.md)

- [ ] เปิด R2 + ตรวจ binding FILES + secrets (runbook ขั้น 1)
- [x] สร้าง D1 preview (00791d04… ; ลบ D1 เดิมแล้วสร้าง prpo-db ใหม่ c64022bb…)
- [ ] backup + apply migrations remote (ถึง 0015 ทั้ง prod/preview ; backup เดิมที่ C:\Users\Admin\prpo-backups)
- [ ] ย้ายข้อมูลจาก Sheets
- [ ] smoke test
- [ ] ตัดระบบ GAS (ปิด web app หรือ clasp push ตัวแก้ทันที)
