const createResponse = () => {
    const headers = new Map();
    const writes = [];
    return {
        headers,
        writes,
        destroyed: false,
        writableEnded: false,
        setHeader(name, value) {
            headers.set(String(name).toLowerCase(), value);
        },
        write(chunk) {
            writes.push(String(chunk));
            return true;
        },
        end() {
            this.writableEnded = true;
        },
        flushHeaders() {}
    };
};

export { createResponse };
