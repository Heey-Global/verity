import { fileMarkdownItems, isMarkdownFile } from './fileMarkdownPreview';

it('recognizes Markdown paths without treating ordinary text as Markdown', () => {
  expect(isMarkdownFile('notes/README.MD')).toBe(true);
  expect(isMarkdownFile('notes.txt')).toBe(false);
});

it('preserves headings, tables and fenced code as distinct rendering items', () => {
  const items = fileMarkdownItems(
    '# Plan\n\n| Task | State |\n| --- | --- |\n| Build | Done |\n\n```ts\nconst x = 1;\n```',
  );
  expect(items).toContainEqual({ type: 'line', content: '# Plan' });
  expect(items).toContainEqual({
    type: 'table',
    header: ['Task', 'State'],
    rows: [['Build', 'Done']],
  });
  expect(items).toContainEqual({ type: 'code', content: 'const x = 1;', lang: 'ts' });
});

it('bounds giant code and prose nodes without losing their contents', () => {
  const content = 'x'.repeat(150000);
  for (const input of [content, '```\n' + content + '\n```']) {
    const items = fileMarkdownItems(input);
    const chunks = items.flatMap((item) => ('content' in item ? [item.content] : []));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 8000)).toBe(true);
    expect(chunks.join('')).toBe(content);
  }
});

it('virtualizes long tables while retaining all rows and column headings', () => {
  const rows = Array.from({ length: 100 }, (_, i) => `| ${i} | Pending |`);
  const items = fileMarkdownItems('| Task | State |\n| --- | --- |\n' + rows.join('\n'));
  const tables = items.filter((item) => item.type === 'table');
  expect(tables.length).toBeGreaterThan(1);
  expect(tables.every((table) => table.header.join(',') === 'Task,State')).toBe(true);
  expect(tables.flatMap((table) => table.rows).map((row) => row[0])).toEqual(
    Array.from({ length: 100 }, (_, i) => String(i)),
  );
});

it('keeps oversized table rows bounded and readable', () => {
  const cell = 'x'.repeat(150000);
  const items = fileMarkdownItems('| Value |\n| --- |\n| ' + cell + ' |');
  expect(items.every((item) => item.type === 'code' && item.content.length <= 8000)).toBe(true);
  expect(items.flatMap((item) => ('content' in item ? [item.content] : [])).join('')).toContain(
    cell,
  );
});
