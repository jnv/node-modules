var root = require('root');
var pejs = require('pejs');
var send = require('send');
var cookie = require('cookie');
var param = require('param');
var fs = require('fs');
var LRU = require('lru-cache');
var req = require('request');
var qs = require('querystring');
var stream = require('stream-wrapper');
var JSONStream = require('JSONStream');
var modules = require('./modules');
var mongo = require('./mongo');
var user = require('./user');

var COOKIE_MAX_AGE = 31 * 24 * 3600 * 1000; // 1 month
var FINGERPRINT_MAX_AGE = 365 * 24 * 3600;
var FINGERPRINT = param('fingerprint') && param('fingerprint').toString('hex');

var app = root();

var cache = LRU(5000);
var anon = user();

stream = stream.defaults({objectMode:true});

var string = function(str) {
	return str ? str+'' : '';
};

var fingerprint = function(url) {
	return FINGERPRINT ? 'http://dzdv0sfntaeum.cloudfront.net/'+FINGERPRINT+url : url;
};

pejs.compress = true;
app.use('response.render', function(filename, locals) {
	var response = this;

	locals = locals || {};
	locals.anon = this.request.user === anon;
	locals.username = locals.anon ? '' : this.request.username;
	locals.fingerprint = fingerprint;
	locals.query = string(this.request.query.q);

	pejs.render(filename, locals, function(err, html) {
		if (err) return response.error(err);
		response.send(html);
	});
});

app.use('request.search', function(callback) {
	var query = string(this.query.q);
	var marker = string(this.query.marker);
	var limit = Math.min(parseInt(this.query.limit, 10) || 20, 50);

	this.user.search(query, {marker:marker, limit:limit}, callback);
});

app.on('route', function(request, response) {
	var c = cookie.parse(request.headers.cookie || '');
	var username = request.query.u || c.username || '';
	if (request.query.u === '') username = '';

	request.username = username = username.toLowerCase();
	request.user = !username ? anon : cache.get(username);
	if (!request.user) cache.set(username, request.user = user(username));

	response.setHeader('Set-Cookie', cookie.serialize('username', username, {maxAge:COOKIE_MAX_AGE}));
});

app.get('/update/modules.json', function(request, response) {
	var updates = modules.update();
	var output = JSONStream.stringify();

	output.pipe(response);

	updates.on('module', function(mod) {
		output.write(mod);
	});
	updates.on('end', function() {
		output.end();
	});
});

app.get('/update/users.json', function(request, response) {
	response.send([]);
});

app.get('/package/{name}.json', function(request, response) {
	modules.get(request.params.name, function(err, module) {
		if (err) return response.error(err);
		response.send(module);
	});
});

app.get('/search.json', function(request, response) {
	request.search(function(err, results) {
		if (err) return response.error(err);
		response.send(results);
	});
});

app.get('/.json', function(request, response) {
	modules.info(function(err, info) {
		if (err) return response.error(err);
		response.send(info);
	});
});

app.get('/public/*', function(request, response) {
	send(request, __dirname+'/public/'+request.params.glob).pipe(response);
});

app.get('/{version}/public/*', function(request, response) {
	response.setHeader('Expires', new Date(Date.now() + FINGERPRINT_MAX_AGE * 1000).toGMTString());
	response.setHeader('Cache-Control', 'public, max-age='+FINGERPRINT_MAX_AGE);
	send(request, __dirname+'/public/'+request.params.glob).pipe(response);
});

app.get('/authorize', function(request, response) {
	var q = encodeURIComponent(string(request.query.q));
	req.post('https://github.com/login/oauth/access_token', {
		form: {
			client_id: param('github.client'),
			client_secret: param('github.secret'),
			code: request.query.code
		}
	}, function(err, res, body) {
		if (err) return response.error(err);
		req('https://api.github.com/user', {
			json:true,
			qs: {
				access_token: qs.parse(body).access_token
			}
		}, function(err, res) {
			if (err) return response.error(err);
			response.redirect('http://'+param('host')+'/search?q='+q+'&u='+string(res.body.login));
		});
	});
});

app.get('/personalize', function(request, response) {
	if (!param('github.secret')) return response.error(new Error('github secret is not configured'));

	var q = encodeURIComponent(string(request.query.q));
	var url = 'https://github.com/login/oauth/authorize?'+qs.stringify({
		client_id: param('github.client'),
		redirect_uri:'http://'+param('host')+'/authorize?q='+q
	});

	response.redirect(url);
});

app.get('/search', function(request, response) {
	request.search(function(err, modules) {
		if (err) return response.error(err);
		response.render(request.query.partial ? 'partials/modules.html' : 'search.html', {modules:modules});
	});
});

app.get('/', function(request, response) {
	modules.info(function(err, info) {
		response.render('index.html', info);
	});
});

app.get('/about', function(request, response) {
	response.render('about.html');
});

app.get('/mission', function(request, response) {
	response.render('mission.html');
});

app.error(404, function(request, response) {
	response.render('error.html', {
		title:'404 Not Found',
		message:'We cannot find the page you are looking for'
	});
});

app.error(function(request, response, opt) {
	if (opt.error) console.error(opt.error.stack);
	response.render('error.html', {
		title:'Something bad happened',
		message:opt.message || 'Unknown error'
	});
});

app.listen(param('port'), function() {
	console.log('app running on http://'+param('host'));
});