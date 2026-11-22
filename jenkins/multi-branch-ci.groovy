def getRepoURL() {
    sh "git config --get remote.origin.url > .git/remote-url"
    return readFile(".git/remote-url").trim()
}

def getCommitSha() {
    sh "git rev-parse HEAD > .git/current-commit"
    return readFile(".git/current-commit").trim()
}

def getCurrentBranch() {
    return env.BRANCH_NAME;
}

void setBuildStatus(String message, String state) {
    repoUrl = getRepoURL()
    commitSha = getCommitSha()

    step([
            $class            : 'GitHubCommitStatusSetter',
            reposSource       : [$class: "ManuallyEnteredRepositorySource", url: repoUrl],
            commitShaSource   : [$class: "ManuallyEnteredShaSource", sha: commitSha],
            errorHandlers     : [[$class: 'ShallowAnyErrorHandler']],
            statusResultSource: [$class: "ConditionalStatusResultSource", results: [[$class: "AnyBuildResult", message: message, state: state]]]
    ]);
}

pipeline {
    agent { label 'flutter' }

    options {
        buildDiscarder(logRotator(artifactNumToKeepStr: '10', artifactDaysToKeepStr:'90'))
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        stage('Get dependencies') {
            steps {
                sh('fvm flutter pub get -v')
            }
        }
        stage('Build runner') {
            steps {
                sh('fvm flutter packages pub run build_runner build --delete-conflicting-outputs')
            }
        }
        stage('Build') {
            steps {
                script {
                    SENTRY_RELEASE = 'flutter-app-ci-' + getCurrentBranch()  + '-' + getCommitSha()
                }
                // The app is served from /flutter/ on the device; the base href has to match.
                sh('fvm flutter build web --web-renderer html --no-web-resources-cdn --base-href /flutter/')
                // Unused with the html renderer; keeps ~19 MB out of the shipped zip.
                sh('rm -rf build/web/canvaskit')
            }
        }
        stage('Prepare artifacts') {
            steps {
                sh('cd build/web && zip ' + SENTRY_RELEASE + '.zip -r *')
            }
        }
    }
    post {
        success {
            setBuildStatus("Build succeeded", "SUCCESS");
            archiveArtifacts artifacts: 'build/web/*.zip', fingerprint: true
            cleanWs()
        }
        failure {
            setBuildStatus("Build failed", "FAILURE");
            cleanWs()
        }
    }
}
