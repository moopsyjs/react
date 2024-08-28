/**
 * We implement a custom util to ensure we can run on react-native and web
 */
export function toBase64(str: string): string {
  let base64 = "";
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  
  for (let i = 0; i < str.length; i += 3) {
    const char1 = str.charCodeAt(i);
    const char2 = str.charCodeAt(i + 1);
    const char3 = str.charCodeAt(i + 2);
  
    const byte1 = char1 >> 2;
    const byte2 = ((char1 & 3) << 4) | (char2 >> 4);
    const byte3 = ((char2 & 15) << 2) | (char3 >> 6);
    const byte4 = char3 & 63;
  
    base64 += characters.charAt(byte1) + characters.charAt(byte2) + characters.charAt(byte3) + characters.charAt(byte4);
  }
  
  // Add padding if necessary
  const padding = str.length % 3;
  if (padding === 1) {
    base64 = base64.slice(0, -2) + "==";
  } else if (padding === 2) {
    base64 = base64.slice(0, -1) + "=";
  }
  
  return base64;
}

export function stringToU8Array(str: string): Uint8Array {
  const array = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    array[i] = str.charCodeAt(i);
  }
  return array;
}