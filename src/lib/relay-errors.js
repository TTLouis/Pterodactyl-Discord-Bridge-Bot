/** Classify only failures which prove that the destination did not accept a send. */
export function classifyRelayError(error, { dispatched = false } = {}) {
  const status = error.httpStatus ?? error.status;
  const code = Number(error.code);
  if (error.deliveryStatus) return error;
  if (status === 429 || error.name === "RateLimitError") {
    error.deliveryStatus = "not-sent";
  } else if ((status >= 400 && status < 500) || [10003, 50001, 50013].includes(code)) {
    error.deliveryStatus = "rejected";
    error.permanent = true;
  } else {
    error.deliveryStatus = dispatched ? "unknown" : "not-sent";
  }
  return error;
}
