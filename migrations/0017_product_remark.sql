-- Product Remark (single value per product, as in the original screen) : text + who / when (set by the server from the token)
ALTER TABLE products ADD COLUMN remark TEXT;
ALTER TABLE products ADD COLUMN remarkUpdatedAt TEXT;
ALTER TABLE products ADD COLUMN remarkUpdatedBy TEXT;
