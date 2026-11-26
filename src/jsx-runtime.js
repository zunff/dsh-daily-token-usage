import React from 'react'

// The automatic JSX runtime, wired to the host's React instance instead of a
// second copy. Vite resolves `react/jsx-runtime` here through a config alias.
export const Fragment = React.Fragment

export function jsx(type, props, key) {
  return React.createElement(type, key === undefined ? props : { ...props, key })
}

export const jsxs = jsx
export const jsxDEV = jsx
