import React, { useState } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  return <main><h1>Generated Counter</h1><output data-testid="counter-value">{count}</output><button data-testid="increment-button" onClick={() => setCount(count + 1)}>Increase</button></main>;
}
