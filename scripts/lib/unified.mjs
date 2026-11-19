const ITEM_KEYS = new Set(["text", "conversation", "context_id", "title", "user_name", "attributes", "custom_attributes", "happened_at", "enrich", "instructions", "upsert", "forceful_relations", "acl"]);
const RESERVED_METADATA_KEYS = new Set("chunk_id sub_tenant_id source_id chunk_content chunk_content_embedding chunk_content_sparse source_title source_url source_upload_time source_last_updated_time source_type source_collection source_owner source_collaborator description description_embedding inferred_content inferred_content_embedding base_metadata layout document_metadata document_metadata_embedding embedding metadata evidence_kind evidence_subject chunk_level parent_chunk_id chunk_generation".split(" "));

function metadataBytes(value) {
  return Buffer.byteLength(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

function validateMetadataKeys(value) {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("metadata numbers must be finite");
  if (Array.isArray(value)) {
    for (const item of value) validateMetadataKeys(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!key || key.startsWith("_") || /\p{Cc}/u.test(key) || Buffer.byteLength(key) > 1024 || RESERVED_METADATA_KEYS.has(key.toLowerCase())) throw new Error(`metadata key ${JSON.stringify(key)} is reserved or invalid`);
      validateMetadataKeys(item);
    }
  }
}

export function validateLayout(layout) {
  if (layout !== "split" && layout !== "unified") throw new Error("layout must be split or unified");
  return layout;
}

function attributeMap(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("unified attributes must be an object");
  return { ...parsed };
}

export function memoryToContext(memory) {
  const keys = new Set(["text", "user_assistant_pairs", "source_id", "title", "user_name", "infer", "custom_instructions", "observation_date", "upsert", "forceful_relations", "acl", "tenant_metadata", "document_metadata", "is_markdown"]);
  if (!memory || typeof memory !== "object" || Array.isArray(memory) || Object.keys(memory).some(key => !keys.has(key))) throw new Error("unsupported unified memory input fields");
  if (memory.user_assistant_pairs != null && (!Array.isArray(memory.user_assistant_pairs) || memory.user_assistant_pairs.some(pair => !pair || Object.keys(pair).some(key => !["user", "assistant"].includes(key))))) throw new Error("unsupported unified conversation input");
  const item = {};
  if (memory.text != null) item.text = memory.text;
  if (memory.user_assistant_pairs != null) item.conversation = memory.user_assistant_pairs.flatMap(pair => [
    { role: "user", content: pair.user }, { role: "assistant", content: pair.assistant }
  ]);
  for (const [from, to] of [["source_id", "context_id"], ["title", "title"], ["user_name", "user_name"],
    ["infer", "enrich"], ["custom_instructions", "instructions"], ["observation_date", "happened_at"],
    ["upsert", "upsert"], ["forceful_relations", "forceful_relations"], ["acl", "acl"]]) {
    if (memory[from] != null) item[to] = memory[from];
  }
  if (memory.tenant_metadata != null) item.attributes = attributeMap(memory.tenant_metadata);
  if (memory.document_metadata != null) item.custom_attributes = attributeMap(memory.document_metadata);
  if (memory.is_markdown != null) item.custom_attributes = { ...item.custom_attributes, is_markdown: memory.is_markdown };
  return item;
}

export function knowledgeToContext(record) {
  const keys = new Set(["text", "content", "id", "title", "timestamp", "happened_at", "infer", "user_name", "instructions", "upsert", "forceful_relations", "acl", "metadata", "additional_metadata", "source", "description", "url", "tenant_id", "sub_tenant_id"]);
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some(key => !keys.has(key))) throw new Error("unsupported unified knowledge input fields");
  if (record.content != null && (typeof record.content !== "object" || Array.isArray(record.content) || Object.keys(record.content).some(key => key !== "text"))) throw new Error("unified knowledge supports only text content; rich content cannot be converted");
  if (record.text != null && record.content != null) throw new Error("unified knowledge requires one text body");
  const item = { text: record.content?.text ?? record.text ?? "" };
  for (const [from, to] of [["id", "context_id"], ["title", "title"], ["happened_at", "happened_at"], ["infer", "enrich"],
    ["user_name", "user_name"], ["instructions", "instructions"], ["upsert", "upsert"], ["forceful_relations", "forceful_relations"], ["acl", "acl"]]) {
    if (record[from] != null) item[to] = record[from];
  }
  if (record.metadata != null) item.attributes = attributeMap(record.metadata);
  if (record.additional_metadata != null) item.custom_attributes = attributeMap(record.additional_metadata);
  for (const [from, to] of [["timestamp", "original_timestamp"], ["source", "source"], ["description", "original_description"], ["url", "url"]]) {
    if (record[from] == null) continue;
    const attributes = item.custom_attributes ?? {};
    if (Object.hasOwn(attributes, to) && JSON.stringify(attributes[to]) !== JSON.stringify(record[from])) throw new Error(`knowledge provenance conflicts with custom_attributes.${to}`);
    item.custom_attributes = { ...attributes, [to]: record[from] };
  }
  return item;
}

export function unifiedBatches(items) {
  if (!Array.isArray(items) || !items.length) throw new Error("unified context must be a non-empty array");
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !ITEM_KEYS.has(key))) {
      throw new Error("unified context contains unsupported fields");
    }
    const text = typeof item.text === "string" && item.text.trim().length > 0;
    const conversation = Array.isArray(item.conversation) && item.conversation.length > 0;
    if (text === conversation) throw new Error("unified context requires text XOR conversation");
    if (item.text != null && typeof item.text !== "string") throw new Error("unified text must be a string");
    if (item.conversation != null && !Array.isArray(item.conversation)) throw new Error("unified conversation must be an array");
    let itemBytes = text ? Buffer.byteLength(item.text) : 0;
    if (conversation) {
      let speech = false;
      for (const turn of item.conversation) {
        if (!turn || Object.keys(turn).some(key => !["role", "content"].includes(key)) ||
          !["user", "assistant", "system"].includes(turn.role) || typeof turn.content !== "string" || !turn.content.trim()) {
          throw new Error("unified conversation turns require role and non-empty content");
        }
        speech ||= turn.role !== "system";
        itemBytes += Buffer.byteLength(turn.content);
      }
      if (!speech) throw new Error("unified conversation requires a user or assistant turn");
    }
    if (itemBytes > 1048576) throw new Error("unified context exceeds the maximum of 1 MiB of text; split the context");
    for (const key of ["enrich", "upsert"]) if (item[key] != null && typeof item[key] !== "boolean") throw new Error(`${key} must be boolean`);
    for (const key of ["attributes", "custom_attributes"]) {
      if (item[key] != null && (typeof item[key] !== "object" || Array.isArray(item[key]))) throw new Error(`${key} must be an object`);
      if (item[key] != null) {
        validateMetadataKeys(item[key]);
        const limit = key === "custom_attributes" ? 1024 : 16384;
        if (metadataBytes(item[key]) > limit) throw new Error(`${key} exceeds the maximum of ${limit} bytes`);
      }
    }
    for (const key of ["context_id", "title", "user_name", "happened_at", "instructions"]) {
      if (item[key] != null && typeof item[key] !== "string") throw new Error(`${key} must be a string`);
    }
    if (item.title != null && Buffer.byteLength(item.title.trim()) > 1024) throw new Error("unified title exceeds 1024 bytes");
    if (item.instructions != null && [...item.instructions.trim()].length > 4000) throw new Error("unified instructions exceed 4000 characters");
    if (item.happened_at != null && (!/^\d{4}-\d{2}-\d{2}$/.test(item.happened_at) ||
      Number.isNaN(Date.parse(item.happened_at)) || new Date(item.happened_at).toISOString().slice(0, 10) !== item.happened_at)) throw new Error("happened_at must be a valid YYYY-MM-DD date");
    if (batch.length === 100 || bytes + itemBytes > 8388608) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += itemBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
