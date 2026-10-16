import React from 'react';
export default function App() { return <main><h1>Bounded CPU timeout probe</h1><button data-testid="burn-button" onClick={() => { while (true) { /* bounded by the worker watchdog and container CPU limit */ } }}>Run bounded probe</button><output data-testid="burn-result">waiting</output></main>; }
