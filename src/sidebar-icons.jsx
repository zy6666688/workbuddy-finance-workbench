import React from 'react'

// One outline family for both the standalone desk and team navigation.
const paths = {
  home: 'M3 11.5 12 4l9 7.5M5.5 10v9h13v-9M9.5 19v-5h5v5',
  revenue: 'M4 18V6m0 12h16M8 14l3-3 3 2 5-6m-3 0h3v3',
  receivables: 'M4 7h16v11H4zM4 10h16M8 15h3m5-1v4m-2-2h4',
  payables: 'M4 7h16v11H4zM4 10h16M8 15h3m4 1h4',
  expenses: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6m-6 4h6m-6 4h3',
  treasury: 'M3 8h18v11H3zM3 8l2-3h14l2 3m-5 5h5m-3 0v2',
  budget: 'M4 5h16v15H4zM8 3v4m8-4v4M4 9h16M8 13h3m-3 3h5m3-3v3',
  assets: 'M4 20h16M6 20V6l6-3 6 3v14M9 9h2m2 0h2m-6 4h2m2 0h2m-4 7v-3h2v3',
  tax: 'M6 3h9l3 3v15H6zM15 3v4h3M9 11h6m-6 4h6m-6 3h3',
  invoices: 'M5 5h14v4a2 2 0 0 0 0 4v6H5v-6a2 2 0 0 0 0-4zM10 8h5m-5 4h5m-5 4h3',
  payroll: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 19c0-3 2-5 5-5s5 2 5 5M17 8h4m-2-2v4m-3 5h5m-2-2v4',
  reconcile: 'M4 7h12m-3-3 3 3-3 3M20 17H8m3-3-3 3 3 3',
  costing: 'M4 5h16v14H4zM8 9h3m-3 3h3m-3 3h3m3-6h3m-3 3h3m-3 3h3',
  statements: 'M6 3h9l3 3v15H6zM15 3v4h3M9 17v-3m3 3V9m3 8v-5',
  analysis: 'M4 19V5m0 14h16M7 15l4-4 3 2 5-6',
  investment: 'M12 20V4M7 9l5-5 5 5M5 20h14',
  exceptions: 'M12 3 3 20h18L12 3Zm0 6v5m0 3h.01',
  audit: 'M6 4h12v16H6zM9 8h6m-6 4h6m-6 4h4M4 7v10',
  backup: 'M4 8h16v11H4zM7 5h10M9 13l3 3 3-3m-3 3v-5',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4',
  'team:orders': 'M5 5h14v15H5zM8 3v4m8-4v4M5 9h14m-10 4h6m-6 3h4',
  'team:companies': 'M3 20h18M5 20V7l5-3v16m0-10 8-3v13M7 9h1m-1 3h1m5-1h2m-2 3h2m-2 3h2',
  'team:review': 'M5 5h14v15H5zM9 3h6v4H9zm0 10 2 2 4-4',
  'team:imports': 'M4 5h16v14H4zM12 16V9m-3 3 3-3 3 3',
  'team:jobs': 'M12 4a8 8 0 1 0 8 8h-3m-5-5v5l3 2m2-7h4v4',
  'team:account': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20c0-4 3-6 7-6s7 2 7 6',
  'team:users': 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 19c0-3 2-5 6-5s6 2 6 5m1-13a3 3 0 0 1 0 6m1 2c2.5.5 4 2 4 5',
  'team:health': 'M4 5h16v6H4zm0 8h16v6H4zm3-5h.01M7 16h.01m3-8h7m-7 8h7',
  'team:audit': 'M6 4h12v16H6zM9 8h6m-6 4h6m-6 4h4M4 7v10',
}

export function SidebarIcon({ name }) {
  return <svg className="fdDesk_navIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name] || 'M4 5h16v14H4zM8 9h8m-8 4h8m-8 4h4'}/></svg>
}
