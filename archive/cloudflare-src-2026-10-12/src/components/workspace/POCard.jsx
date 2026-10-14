import React from 'react';
import TaskCard from './TaskCard.jsx';

/**
 * POCard Component
 * Modern Minimal Bento Card for Purchase Orders
 */
export default function POCard({ po, task, currentRole, onClick }) {
  const targetDoc = task || (po ? { ...po, docType: 'PO' } : {});
  return <TaskCard task={targetDoc} currentRole={currentRole} onClick={onClick} />;
}
