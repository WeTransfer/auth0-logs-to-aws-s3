const async = require('async');
const AWS = require('aws-sdk');
const moment = require('moment');
const useragent = require('useragent');

const loggingTools = require('auth0-log-extension-tools');
const config = require('../lib/config');
const logger = require('../lib/logger');

module.exports = (storage) =>
  (req, res, next) => {
    const wtBody = (req.webtaskContext && req.webtaskContext.body) || req.body || {};
    const wtHead = (req.webtaskContext && req.webtaskContext.headers) || {};
    const isCron = (wtBody.schedule && wtBody.state === 'active') || (wtHead.referer === `${config('AUTH0_MANAGE_URL')}/` && wtHead['if-none-match']);

    if (!isCron) {
      return next();
    }

    AWS.config.update({
      accessKeyId: config('AWS_ACCESS_KEY_ID'),
      secretAccessKey: config('AWS_SECRET_ACCESS_KEY'),
      region: config('AWS_REGION'),
    });
    const s3 = new AWS.S3({apiVersion: '2006-03-01'});

    const remapLogs = (record) => {
      record.type_code = record.type;
      record.type = loggingTools.logTypes.get(record.type);

      if (record.user_agent && record.user_agent.length) {
        let agent = useragent.parse(record.user_agent);
        record.os = agent.os.toString();
        record.os_version = agent.os.toVersion();
        record.device = agent.device.toString();
        record.device_version = agent.device.toVersion();
      }

      return record;
    };

    const onLogsReceived = (logs, callback) => {
      if (!logs || !logs.length) {
        return callback();
      }

      logger.info(`Sending ${logs.length} logs to AWS S3.`);

      async.eachLimit(logs.map(remapLogs), 5, (log, cb) => {
        const date = moment(log.date);
        const url = `${date.format('YYYY/MM/DD')}/${date.format('HH')}/${log._id}.json`;

        const params = {
          Bucket: config('AWS_BUCKET_NAME'),
          Key: url,
          Body: JSON.stringify(log),
          ContentType: 'application/json',
          ServerSideEncryption: 'AES256',
        };
        s3.putObject(params, (err) => cb(err));
      }, (err) => {
        if (err) {
          return callback(err);
        }

        logger.info('Upload complete.');
        return callback();
      });
    };

    const slack = new loggingTools.reporters.SlackReporter({
      hook: config('SLACK_INCOMING_WEBHOOK_URL'),
      username: 'auth0-logs-to-aws-s3',
      title: 'Logs To AWS S3' });

    const options = {
      domain: config('AUTH0_DOMAIN'),
      clientId: config('AUTH0_CLIENT_ID'),
      clientSecret: config('AUTH0_CLIENT_SECRET'),
      batchSize: config('BATCH_SIZE'),
      startFrom: config('START_FROM'),
      logTypes: config('LOG_TYPES'),
      logLevel: config('LOG_LEVEL')
    };

    if (!options.batchSize || options.batchSize > 100) {
      options.batchSize = 100;
    }

    if (options.logTypes && !Array.isArray(options.logTypes)) {
      options.logTypes = options.logTypes.replace(/\s/g, '').split(',');
    }

    const auth0logger = new loggingTools.LogsProcessor(storage, options);

    const sendDailyReport = (lastReportDate) => {
      const current = new Date();

      const end = current.getTime();
      const start = end - 86400000;
      auth0logger.getReport(start, end)
        .then(report => slack.send(report, report.checkpoint))
        .then(() => storage.read())
        .then((data) => {
          data.lastReportDate = lastReportDate;
          return storage.write(data);
        });
    };

    const checkReportTime = () => {
      storage.read()
        .then((data) => {
          const now = moment().format('DD-MM-YYYY');
          const reportTime = config('DAILY_REPORT_TIME') || 16;

          if (data.lastReportDate !== now && new Date().getHours() >= reportTime) {
            sendDailyReport(now);
          }
        })
    };

    return auth0logger
      .run(onLogsReceived)
      .then(result => {
        if (result && result.status && result.status.error) {
          slack.send(result.status, result.checkpoint);
        } else if (config('SLACK_SEND_SUCCESS') === true || config('SLACK_SEND_SUCCESS') === 'true') {
          slack.send(result.status, result.checkpoint);
        }
        checkReportTime();
        res.json(result);
      })
      .catch(err => {
        slack.send({ error: err, logsProcessed: 0 }, null);
        checkReportTime();
        next(err);
      });
  };
