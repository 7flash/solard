import { render } from 'tradjs/client';

function App() {
    return (
        <div style={{ padding: '20px', background: '#18181b', borderRadius: '12px', color: '#e4e4e7' }}>
            <p>✨ Client interactivity works! Edit <code>app/page.client.tsx</code> to add more.</p>
        </div>
    );
}

export default function mount() {
    const root = document.getElementById('app-root');
    if (!root) return;
    render(<App />, root);
    return () => render(null, root);
}
