import React, { useState } from 'react';
export default function App() {
  const [name, setName] = useState('');
  return <main><h1>Generated Todo — no-op fixture</h1><input data-testid="task-input" value={name} onChange={e => setName(e.target.value)} /><button data-testid="add-button" onClick={() => console.warn('Injected Add no-op')}>Add</button><ul data-testid="task-list"></ul></main>;
}
