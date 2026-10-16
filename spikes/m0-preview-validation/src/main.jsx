import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const fault = new URLSearchParams(location.search).get('fault') === 'add-noop';

function Todo() {
  const [name, setName] = useState('');
  const [tasks, setTasks] = useState([]);

  function add(event) {
    event.preventDefault();
    if (fault) {
      console.warn('M0 controlled fault: Add handler did not append a task');
      return;
    }
    if (!name.trim()) return;
    setTasks((previous) => [...previous, name.trim()]);
    console.info('M0 task added', name.trim());
    setName('');
  }

  return (
    <main>
      <p className="eyebrow">Mini Atoms · M0 technical spike</p>
      <h1>Todo preview</h1>
      <p data-testid="mode">Mode: {fault ? 'fault / Add no-op' : 'normal'}</p>
      <form onSubmit={add}>
        <label htmlFor="task">Task name</label>
        <div className="row">
          <input id="task" data-testid="task-input" autoComplete="off"
            value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" data-testid="add-button">Add</button>
        </div>
      </form>
      <ul data-testid="task-list">
        {tasks.map((task, index) => <li data-testid="task-item" key={index}>{task}</li>)}
      </ul>
      {tasks.length === 0 && <p className="empty">No tasks yet.</p>}
      <footer>Build <code data-testid="app-version">{__APP_VERSION__}</code></footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Todo />);
