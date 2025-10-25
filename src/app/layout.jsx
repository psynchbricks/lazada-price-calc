// src/app/layout.jsx
export const metadata = {
  title: "Lazada Price Calculator",
  description: "Compute selling prices with full Lazada fee logic"
};

export default function RootLayout({ children }) {
  return (
    <html lang="th">
      <body style={{ margin: 0, fontFamily: 'Inter, sans-serif', background: '#fafafa' }}>
        {children}
      </body>
    </html>
  );
}
