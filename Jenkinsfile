pipeline {
    agent any
    options {
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }
    stages {
        stage('Demo') {
            steps {
                echo 'YadinStore CI/CD Live'
                echo "BE-JD Pipeline as Code — Build #${env.BUILD_NUMBER} — ${env.JOB_NAME}"
                script {
                    sh 'echo "YadinStore CI/CD Live — $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee yadinstore-demo.log'
                }
                archiveArtifacts artifacts: 'yadinstore-demo.log', allowEmptyArchive: true
            }
        }
        stage('Verify') {
            steps {
                echo 'Jobs: 1 | Queue: 0 | Executors: 0/2 — Dashboard LIVE'
            }
        }
    }
    post {
        success {
            echo 'SUCCESS — YadinStore CI/CD Live'
        }
    }
}
