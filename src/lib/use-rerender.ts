import React from "react";

export function useRerender() {
  const [, set] = React.useState({});
  return React.useCallback(() => set({}), []);
}