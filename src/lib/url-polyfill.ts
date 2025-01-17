function getCurrentHref(): string {
  try {
    return window.location.href;
  }
  catch(e) {
    return "";
  }
}

export function getWebsocketURL(baseURL: string): string {
  if(!baseURL.startsWith("http")) {
    baseURL = getCurrentHref() + baseURL;
  }

  const isHttps = baseURL.startsWith("https://");
  const trimmedBase = baseURL.replace(/^https?:\/\//, "").split("/")[0];
  return `${isHttps ? "wss" : "ws"}://${trimmedBase}/moopsy_ws`;
}