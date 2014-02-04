/**
 * Author: Robert Taylor
 * Date: 10/5/12
 */
/* global define, require */
define(['angular',
    'underscore',
    'config',
    'consts',
    'session',
    'reportCard',
    'template',
    'lms',
    'settings',
    'utils/async',
    'utils/cache',
    'utils/compare',
    'utils/data',
    'utils/logger',
    'utils/parser',
    'utils/access'
],
    function (angular, _, config, consts, session, reportCard, template, lms, settings, async, cache, compare, dataUtil, logger, parser, access) {
        'use strict';
        angular.module('app').controller('MainCtrl', ['$scope', '$routeParams', '$interpolate', '$log',
            function ($scope, $routeParams, $interpolate, $log) {

                // global settings
                $scope.settings = settings;
                // global strings
                $scope.strings = null;
                // reference to question
                $scope.question = null;
                // reference to widget (widgets used to display slide on screen)
                $scope.widget = null;
                // report card
                $scope.reportCard = reportCard;
                // This is required by session to interpolate paths
                $scope.properties = {};
                // this is required by session to interpolate paths
                $scope.session = session;
                // set slide url to initialize load
                $scope.slideUrl = consts.VIEW_PATH + 'slide.html';
                // used for initialization
                $scope.template = null;

                /**
                 * Entry point for initialization
                 */
                function init() {

                    // waterfall controls the flow in which the async workers execute
                    async.waterfall([], [ initBuildUp, initSession, initNamespaces, initWhitelist, initStrings, initResources,
                        initQuestion, initRestorePoint, initLMS, initWatchers, initApplication ], initTearDown);
                }

                /**
                 * Add any resources needed to perform initialization
                 * @param next
                 */
                function initBuildUp(next) {
                    $scope.template = template;
                    next();
                }

                /**
                 *  Clears the session (all previous data)
                 */
                function initSession(next) {
                    session.clear();
                    next();
                }

                /**
                 * Populates the global namespace with a few properties to allow compiles to work properly
                 * @param next
                 */
                function initNamespaces(next) {
                    window.fn = cache("functions").all();
                    cache().set('app', $scope);
                    next();
                }

                /**
                 * Initialize white list
                 * @param next
                 */
                function initWhitelist(next) {
                    settings.parseWhiteList(config.whitelist);
                    next();
                }

                /**
                 * Initialize LMS
                 * @param next
                 */
                function initLMS(next) {
                    if (settings.local_mode) {
                        return next();
                    }

                    lms.init(settings.local_mode, $scope.question.weight, function (success) {
                        if (success) {
                            next();
                        }
                    });
                }

                /**
                 * Loads the global strings
                 * @param next
                 */
                function initStrings(next) {
                    $scope.strings = session[consts.EXAM_STRINGS] = {};
                    var url = config.paths.exam + config.global.strings + '.xml';
                    template.get(url, {type: 'strings'}).then(function (info) {
                        next();
                    });
                }

                /**
                 * Preloads any resources that may be indirectly used
                 * @param next
                 */
                function initResources(next) {
                    if (config.global.resources) {
                        var resourcesUrl = config.paths.exam + config.global.resources + '.xml';
                        template.get(resourcesUrl, {type: 'resources'}).then(function (info) {
                            next();
                        });
                    }
                }

                /**
                 * Load question
                 * @param next
                 */
                function initQuestion(next) {
                    var questionUrl = config.paths.exam + config.paths.questions + $routeParams.qid + '.xml';
                    template.get(questionUrl, {type: 'question'}).then(function (info) {
                        $scope.question = info.template;
                        // this is setup as widget.src because that is how all the other widgets reference
                        $scope.widget = { src: $scope.question.view };

                        var fn;
                        angular.forEach($scope.question.init, function (actions, type) {
                            if (cache('actions').has(type)) {
                                fn = cache('actions').get(type);
                                actions = dataUtil.toArray(actions);
                                angular.forEach(actions, function (action) {
                                    if (action) {
                                        fn($scope, action);
                                    }
                                });
                            }
                        });

                        next();
                    });
                }

                /**
                 * Sets up another load listener to pick up any last minute resource requests upon instantiation
                 * @param next
                 */
                function initApplication(next) {
                    var stopWatch = $scope.$watch(function () {
                        stopWatch();
                        // wait for slides indicate they are now being instantiated
                        var offSourceChanged = $scope.$on('slide::sourceChanged', _.debounce(function () {
                            offSourceChanged();
                            var off = $scope.$watch('template.loader.state', function (state) {
                                if (state === 'ready') {
                                    off();
                                    next();
                                }
                            });

                            $scope.tryApply();

                        }, 1)); // wait until last sourceChange request has been issued in thread
                    });

                }

                /**
                 * Creates a restore point to be used by reset
                 * @param next
                 */
                function initRestorePoint(next) {
                    session.createRestorePoint();
                    next();
                }

                /**
                 * Creates any watches necessary to perform tasks
                 * @param next
                 */
                function initWatchers(next) {
                    $scope.$watch('session.data', function () {
                        reportCard.update($scope, $scope.question.score);
                    }, true);

                    access.init();

                    next();
                }

                /**
                 * Called at the end of the flow
                 * @param err
                 */
                function initTearDown(err) {
                    if (err) {
                        console.error(err);
                    } else {
                        // lms final call
                        lms.ready();
                        // remove local props
                        $scope.template = null;
                        // hide splash
                        angular.element(document).trigger(consts.HIDE_SPLASH);
                    }
                }

                /**
                 * Traverses through to find a command, dispatch, or function
                 * @param scope
                 * @param command
                 * @return {*}
                 */
                $scope.invoke = function (scope, name) {
                    if (name) {
                        async.waterfall([scope, name],
                            [invokeCommand, invokeDispatch, invokeFunction, invokeNext, invokeDefaultCommand]);
                    }
                };

                /**
                 * Try to invoke a command
                 * @param scope
                 * @param name
                 * @param next
                 */
                function invokeCommand(scope, name, next) {
                    if (name.indexOf('::') !== -1) {
                        logger.log('fn', name);
                        cache('actions').get('exec')($scope, {command: name});
                        return;
                    }
                    next(scope, name);
                }

                /**
                 * Try to invoke a dispatch
                 * @param scope
                 * @param name
                 * @param next
                 */
                function invokeDispatch(scope, name, next) {
                    if (/dispatch/.test(name)) {
                        var eventName = name.replace(/dispatch\(\'(\w+)(.*)/, "$1");
                        $scope.run(scope, {action: { type: "dispatch", name: eventName}});
                        return;
                    }
                    next(scope, name);
                }

                /**
                 * Try to invoke a function
                 * @param scope
                 * @param name
                 * @param next
                 */
                function invokeFunction(scope, name, next) {
                    var fnPayload = scope.functions ? scope.functions[name] : undefined;
                    if (fnPayload) {
                        logger.log('fn', name, fnPayload, scope);
                        $scope.run(scope, fnPayload);
                        return;
                    }
                    next(scope, name);
                }

                /**
                 * Try to go up parent chain
                 * @param scope
                 * @param name
                 * @param next
                 */
                function invokeNext(scope, name, next) {
                    if ($scope !== scope) { // continue to find the function as long as we are not the application
                        return $scope.invoke(scope.$parent, name);
                    }
                    next(scope, name);
                }

                /**
                 * All else fails, invoke default command
                 * @param scope
                 * @param name
                 */
                function invokeDefaultCommand(scope, name) {
                    if (name !== "default") { // no function found, then use "default" function
                        logger.log('fn', name);
                        cache('actions').get('exec')($scope, {command: config.defaults.command});
                    }
                }

                /**
                 * Run the condition. Supports conditions within conditions.
                 * @param scope
                 * @param conds
                 * @return {Boolean}
                 */
                $scope.runCondition = function (scope, conds) {

                    if (!conds) {
                        return false;
                    }
                    conds = [].concat(conds);
                    var i = 0, len = conds.length, expr, fn, val, result, cond;
                    while (i < len) {
                        cond = conds[i];
                        if ('expression' in cond) {// allow condition to be evaluated directly.
                            expr = parser.transformProp(cond.expression + '', true);
                            fn = $interpolate(expr);
                            val = fn(scope); // interpolate (this is what gets the current model values
                            result = false;
                            try {
                                result = scope.$eval(val);
                            } catch (e) {
                                $log.error('Malformed expression in condition: ' + cond.expression + '. Check for literals that should be strings.');
                            }

                            if (result) {
                                $scope.run(scope, cond);
                                return true;
                            }
                        } else if ('property' in cond) {
                            // loop through operators looking for a pass
                            for (var e in compare.operators) {
                                if (compare.operators.hasOwnProperty(e)) {
                                    var operator = compare.operators[e];
                                    if (cond[operator] !== undefined && compare.test(session.get(scope, cond[operator]), operator,
                                        session.get(scope, cond.property, true))) {
                                        $scope.run(scope, cond);
                                        return true;
                                    }
                                }
                            }
                        }
                        i += 1;
                    }
                    return false;
                };

                /**
                 * Runs the command requests
                 * @param scope
                 * @param functions
                 */
                $scope.run = function (scope, functions) {
                    if (functions && functions.action) {
                        angular.forEach(dataUtil.toArray(functions.action), function (action, key) {
                            cache("actions").get(action.type)(scope, action, $scope);
                        });
                    }
                };

                $scope.toggleConsole = function () {
                    settings.toggleConsole();
                };

                /**
                 * Called within header (custom buttons)
                 * @param action
                 */
                $scope.callAction = function (action) {
                    $scope.invoke($scope, action);
                };

                /**
                 * Resets application
                 */
                $scope.reset = function () {
                    angular.element.popup.closeAllGroups();
                    session.restore();
                };

                $scope.on = function (event, handler) {
                    return $scope.$on(event, handler);
                };

                /**
                 * Permits any DOM element or sub controller to call exec directly
                 * @param evtType
                 * @param widget
                 */
                $scope.$on('dispatch', function (evt, scope, eventType, widget) {
                    if (widget) {
                        if (widget[eventType]) {
                            $scope.invoke(scope, widget[eventType]);
                        } else if (widget.events && widget.events[eventType]) {
                            $scope.invoke(scope, widget.events[eventType]);
                        }
                    }
                });

                /**
                 * Try to call angular apply()
                 */
                $scope.tryApply = function () {
                    if (!$scope.$$phase) {
                        $scope.$apply();
                    }
                };

                init();

            }]);
    });