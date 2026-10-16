export const policy = Object.freeze({
  version: 'm0.5-controlled-build-1', maxFiles: 12, maxFileBytes: 65536,
  maxInputBytes: 262144, maxOutputBytes: 1048576, timeoutMs: 20000,
  allowedBareImports: ['react'],
});
export class BuildRejected extends Error { constructor(message, code = 'INVALID_SOURCE') { super(message); this.name = 'BuildRejected'; this.code = code; } }
export function validateSource(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['schemaVersion', 'files', 'summary'].includes(k)) || input.schemaVersion !== '0.1' || !Array.isArray(input.files)) throw new BuildRejected('Invalid source envelope');
  if (input.files.length < 1 || input.files.length > policy.maxFiles) throw new BuildRejected('File count limit exceeded', 'SOURCE_LIMIT');
  const files = {}, normalized = new Set();
  let total = 0;
  for (const file of input.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'content,path' || typeof file.path !== 'string' || typeof file.content !== 'string') throw new BuildRejected('Only string path/content fields are accepted');
    const name = file.path;
    if (!(name === 'src/App.tsx' || name === 'src/styles.css' || /^src\/components\/[A-Za-z][A-Za-z0-9_-]{0,48}\.tsx$/.test(name))) throw new BuildRejected(`Path is not allowed: ${name}`, 'PATH_REJECTED');
    const normalizedName = name.normalize('NFKC').toLowerCase();
    if (normalized.has(normalizedName)) throw new BuildRejected('Duplicate normalized path', 'PATH_REJECTED');
    normalized.add(normalizedName);
    const size = Buffer.byteLength(file.content);
    total += size;
    if (size > policy.maxFileBytes || total > policy.maxInputBytes) throw new BuildRejected('Source size limit exceeded', 'SOURCE_LIMIT');
    files[name] = file.content;
  }
  if (!Object.hasOwn(files, 'src/App.tsx')) throw new BuildRejected('src/App.tsx is required');
  return files;
}
