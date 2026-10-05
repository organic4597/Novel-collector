export const APP_VERSION = "1.0.0.6";
export const UPDATE_REPOSITORY = "organic4597/Novel-collector";

export function versionParts(value) {
  if(typeof value!=="string"||!/^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:\.\d{1,6})?$/.test(value))throw Error("지원하는 릴리스 버전이 아닙니다.");
  const parts=value.replace(/^v/,"").split(".").map(Number);while(parts.length<4)parts.push(0);return parts;
}
export function compareVersions(a,b) {
  const left=versionParts(a),right=versionParts(b);
  for(let i=0;i<4;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;return 0;
}
export function repositoryName(value=UPDATE_REPOSITORY) {
  if(typeof value!=="string")throw Error("GitHub 저장소를 확인하세요.");
  const name=value.replace(/^https:\/\/github\.com\//,"").replace(/\.git\/?$/,"").replace(/\/$/,"");
  if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name))throw Error("GitHub owner/repository 형식을 사용하세요.");return name;
}
