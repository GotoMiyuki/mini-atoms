import React, { useState } from 'react';
import './styles.css';
export default function App() {
  const [name, setName] = useState('');
  const [tasks, setTasks] = useState<string[]>([]);
  return <main><h1>Generated Todo</h1><label>Task <input data-testid="task-input" value={name} onChange={e => setName(e.target.value)} /></label><button data-testid="add-button" onClick={() => { if (name.trim()) { setTasks([...tasks, name.trim()]); setName(''); } }}>Add</button><ul data-testid="task-list">{tasks.map((task, index) => <li data-testid="task-item" key={index}>{task}</li>)}</ul></main>;
}
