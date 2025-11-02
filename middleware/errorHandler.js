module.exports = (err, req, res, next) => {
    console.error("Error:", err);

    // Default status code
    const statusCode = err.statusCode || 500;

    // Ensure consistent response format
    res.status(statusCode).json({
        message: err.message || "Internal Server Error",
        data: {}
    });
};
