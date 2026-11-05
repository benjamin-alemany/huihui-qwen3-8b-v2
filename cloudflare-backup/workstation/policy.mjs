export function mutationAllowed(request, origin) {
  return request.headers.get("Origin")===origin &&
    request.headers.get("Content-Type")?.split(";")[0].trim()==="application/json" &&
    request.headers.get("X-Workstation-Request")==="1";
}
