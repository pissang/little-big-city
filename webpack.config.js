module.exports = {
    entry: __dirname + '/src/main.js',
    devtool: 'sourcemap',
    output: {
        path: __dirname + '/dist',
        filename: 'bundle.js'
    }
};