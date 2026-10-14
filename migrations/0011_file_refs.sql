-- 0011: file_refs = index "Drive file -> the PR / PO that really holds it as a file" (GET /api/files/:id and the write-side file check look it up
-- by index instead of scanning every document's JSON). Rebuilt for a document each time it is saved (functions/_lib/filerefs.js : reindexDoc) from the
-- same extraction the write side verifies (sanitize.fileIdsIn). Rows are only a lookup aid : the reader re-checks the document before trusting one.
-- Old / imported documents are not in it until they are next saved ; the reader falls back to a bounded, throttled scan and indexes what it finds.
CREATE TABLE IF NOT EXISTS file_refs (
    fileId   TEXT NOT NULL,
    docTable TEXT NOT NULL,          -- 'prs' | 'pos'
    docId    TEXT NOT NULL,          -- prs.id / pos.id
    docNo    TEXT,                   -- prNumber / poNumber (for cleanup when the document is deleted)
    PRIMARY KEY (fileId, docTable, docId)
);
CREATE INDEX IF NOT EXISTS idx_file_refs_doc ON file_refs(docTable, docId);

-- attachments of a deleted PR are marked (the Drive file stays) so a later document can never inherit them through the same number / id
ALTER TABLE attachments ADD COLUMN docGone INTEGER NOT NULL DEFAULT 0;
