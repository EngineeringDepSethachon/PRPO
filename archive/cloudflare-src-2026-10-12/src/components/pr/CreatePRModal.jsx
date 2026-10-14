import React, { useState, useEffect } from 'react';
import PRCreateView from '../../views/PRCreateView';
import { getNextPRNumber } from '../../utils/idGenerator';
import { useAppContext } from '../../context/AppContext';
import { storageService } from '../../services/storageService';

/**
 * CreatePRModal - Form for creating a new PR (supports modal & embedded mode)
 * Directive 2: Dynamic Max-ID scanner on open, strictly no hardcoded PD001/2026 or useState(1)
 */
export default function CreatePRModal(props) {
  const context = useAppContext ? useAppContext() : {};
  const existingPRs = props.existingPRs || context?.prs || storageService.getPRs?.() || [];
  const currentDept = props.currentDept || props.department || props.currentRole?.department || 'PD';

  // เมื่อเปิด Modal ขึ้นมา ให้เรียกฟังก์ชัน getNextPRNumber(existingPRs, currentDept) มาใช้เป็น Initial State ทันที
  // ห้าม Hardcode ค่าเริ่มต้นเป็น PD001/2026 หรือพึ่งพาตัวแปร useState(1) ที่รีเซ็ตทุกครั้งที่โหลดหน้าเว็บใหม่
  const [initialPRNo, setInitialPRNo] = useState(() => {
    return props.initialPRNo || getNextPRNumber(existingPRs, currentDept);
  });

  useEffect(() => {
    if (!props.initialPRNo) {
      setInitialPRNo(getNextPRNumber(existingPRs, currentDept));
    }
  }, [existingPRs, currentDept, props.initialPRNo]);

  const handleSave = props.handleSavePR || props.createPR || props.onSave || props.onSubmit || context?.handleSavePR || context?.createPR;

  return (
    <PRCreateView
      {...props}
      initialPRNo={initialPRNo}
      handleSavePR={handleSave}
      createPR={handleSave}
    />
  );
}

export { PRCreateView, getNextPRNumber };

